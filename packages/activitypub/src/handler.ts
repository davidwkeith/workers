/**
 * The stateless ActivityPub front door.
 *
 * It serves the static actor document and the NodeInfo discovery documents
 * directly, verifies inbound `POST /inbox` HTTP signatures at the edge, and
 * routes everything that touches authoritative state — collection reads, the
 * inbox, the owner publish endpoint — to the per-actor Durable Object, which
 * owns dedup, the follower/outbox collections, and the signed delivery queue.
 * The handler routes purely on the request URL, so it is mountable under any
 * path prefix (include the prefix in `baseUrl`).
 */

import { hostFromUrl, type LogFields } from "@dwk/log";

import {
  AS2_CONTENT_TYPE,
  buildActorDocument,
  wantsActivityJson,
  type JsonValue,
} from "./as2";
import {
  buildNodeInfo21,
  buildNodeInfoDiscovery,
  type UsageCounts,
} from "./nodeinfo";
import {
  INTERNAL_HEADERS,
  resolveConfig,
  type ActivityPubConfig,
  type ActivityPubEnv,
  type ForwardedConfig,
  type ResolvedConfig,
} from "./config";
import {
  ActivityPubLogEvent,
  ApOutcome,
  OUTCOME_ACTIVITY_HEADER,
  OUTCOME_HEADER,
} from "./log";
import { verifyInboxSignature, type InboxRequest } from "./signature";

/** A `fetch`-compatible Worker handler. */
export type ActivityPubHandler = (
  request: Request,
  env: ActivityPubEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Fail loudly if a required Cloudflare binding is missing. */
function assertBindings(env: ActivityPubEnv): void {
  if (!env.ACTOR) {
    throw new Error(
      "@dwk/activitypub: missing required Durable Object binding `ACTOR`",
    );
  }
}

/** The path portion of an IRI, for route matching. */
function pathOf(iri: string): string {
  return new URL(iri).pathname;
}

function jsonResponse(
  body: JsonValue,
  contentType: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Build the config subset the DO needs (including signing key material). */
function forwardedConfig(config: ResolvedConfig): ForwardedConfig {
  return {
    iris: config.iris,
    actorName: config.actor.name ?? config.actor.username,
    manuallyApprovesFollowers: config.actor.manuallyApprovesFollowers ?? false,
    pageSize: config.pageSize,
    deliveryMaxAttempts: config.deliveryMaxAttempts,
    deliveryBaseDelayMs: config.deliveryBaseDelayMs,
    keyId: config.iris.keyId,
    ...(config.privateKeyPem ? { privateKeyPem: config.privateKeyPem } : {}),
  };
}

/** Emit a structured event on both the logger and the metrics seam. */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/** Reach the per-actor Durable Object (one per actor IRI; no sharding). */
function actorStub(config: ResolvedConfig, env: ActivityPubEnv) {
  const id = env.ACTOR.idFromName(config.iris.id);
  return env.ACTOR.get(id);
}

/** Forward a request to the DO with the internal config (and optional) headers. */
function forwardToDo(
  config: ResolvedConfig,
  env: ActivityPubEnv,
  url: string,
  init: {
    method: string;
    body?: BodyInit | null;
    extra?: Record<string, string>;
  },
): Promise<Response> {
  const headers = new Headers();
  headers.set(INTERNAL_HEADERS.config, JSON.stringify(forwardedConfig(config)));
  const accept = init.extra?.accept;
  if (accept) headers.set("accept", accept);
  for (const [k, v] of Object.entries(init.extra ?? {})) {
    if (k !== "accept") headers.set(k, v);
  }
  const request = new Request(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return actorStub(config, env).fetch(request);
}

/**
 * Translate the DO's internal inbound-outcome header into the matching log
 * event, then strip it before the response reaches the peer.
 */
function logInboxOutcome(config: ResolvedConfig, response: Response): Response {
  const outcome = response.headers.get(OUTCOME_HEADER);
  if (!outcome) return response;
  if (outcome === ApOutcome.InboxAccepted) {
    emit(config, "info", ActivityPubLogEvent.InboxAccepted, {
      activity: response.headers.get(OUTCOME_ACTIVITY_HEADER) ?? undefined,
    });
  } else if (outcome === ApOutcome.InboxDuplicate) {
    emit(config, "info", ActivityPubLogEvent.InboxDuplicate);
  }
  const headers = new Headers(response.headers);
  headers.delete(OUTCOME_HEADER);
  headers.delete(OUTCOME_ACTIVITY_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Verify an inbound `POST /inbox` signature, via the override or the built-in. */
async function verifySignature(config: ResolvedConfig, inbox: InboxRequest) {
  if (config.verifyInboxSignature) {
    return config.verifyInboxSignature(inbox);
  }
  return verifyInboxSignature(inbox, config.keyResolver, {
    clockSkewSeconds: config.clockSkewSeconds,
    now: config.now,
  });
}

/**
 * Create the stateless ActivityPub front-door handler. The actor document and
 * NodeInfo are served here; all authoritative state lives in the
 * {@link ActivityPubObject} the request is routed to.
 */
export function createActivityPub(
  config: ActivityPubConfig,
): ActivityPubHandler {
  const resolved = resolveConfig(config);
  const iris = resolved.iris;

  const actorPath = pathOf(iris.id);
  const inboxPath = pathOf(iris.inbox);
  const outboxPath = pathOf(iris.outbox);
  const followersPath = pathOf(iris.followers);
  const followingPath = pathOf(iris.following);
  const nodeInfoDocPath = new URL(`${resolved.baseUrl}/nodeinfo/2.1`).pathname;

  return async (request, env, _ctx) => {
    assertBindings(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // --- NodeInfo (static discovery + mostly-static 2.1 doc) ---------------
    if (path === "/.well-known/nodeinfo" && method === "GET") {
      return jsonResponse(
        buildNodeInfoDiscovery(resolved.baseUrl),
        JSON_CONTENT_TYPE,
      );
    }
    if (path === nodeInfoDocPath && method === "GET") {
      const usage = await nodeInfoUsage(resolved, env);
      return jsonResponse(
        buildNodeInfo21(resolved.software, usage),
        JSON_CONTENT_TYPE,
      );
    }

    // --- Actor document (static, served at the edge) ------------------------
    if (path === actorPath) {
      if (method !== "GET" && method !== "HEAD") {
        return text(405, "Method Not Allowed");
      }
      const body = JSON.stringify(
        buildActorDocument(iris, resolved.actor, resolved.publicKeyPem),
      );
      // Serve AS2 to federation peers; an HTML profile page is out of scope.
      void wantsActivityJson(request.headers.get("accept"));
      return new Response(method === "HEAD" ? null : body, {
        status: 200,
        headers: { "content-type": AS2_CONTENT_TYPE },
      });
    }

    // --- Inbox: verify signature at the edge, then route to the DO ----------
    if (path === inboxPath) {
      if (method !== "POST") {
        return forwardToDo(resolved, env, request.url, { method });
      }
      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      const inbox: InboxRequest = {
        method,
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: bodyBytes,
      };
      const result = await verifySignature(resolved, inbox);
      if (!result.ok) {
        emit(resolved, "warn", ActivityPubLogEvent.SignatureRejected, {
          reason: result.reason,
        });
        return text(401, `invalid_signature: ${result.reason}`);
      }
      emit(resolved, "info", ActivityPubLogEvent.SignatureAccepted, {
        actorHost: hostFromUrl(result.actor),
      });
      const response = await forwardToDo(resolved, env, request.url, {
        method,
        body: bodyBytes as BufferSource,
        extra: { [INTERNAL_HEADERS.signedActor]: result.actor },
      });
      return logInboxOutcome(resolved, response);
    }

    // --- Owner publish endpoint (the micropub → Create fan-out seam) --------
    if (path === outboxPath && method === "POST") {
      if (!resolved.publishToken) {
        emit(resolved, "warn", ActivityPubLogEvent.PublishRejected, {
          reason: "disabled",
        });
        return text(404, "Not Found");
      }
      if (!authorizedPublish(request, resolved.publishToken)) {
        emit(resolved, "warn", ActivityPubLogEvent.PublishRejected, {
          reason: "unauthorized",
        });
        return text(401, "Unauthorized");
      }
      const body = new Uint8Array(await request.arrayBuffer());
      return forwardToDo(resolved, env, request.url, {
        method,
        body: body as BufferSource,
        extra: { [INTERNAL_HEADERS.publish]: "1" },
      });
    }

    // --- Collection reads (authoritative; routed to the DO) -----------------
    if (
      method === "GET" &&
      (path === outboxPath || path === followersPath || path === followingPath)
    ) {
      return forwardToDo(resolved, env, request.url, { method });
    }
    if (path === inboxPath || path === outboxPath) {
      // Non-GET/POST on a collection: let the DO answer 405.
      return forwardToDo(resolved, env, request.url, { method });
    }

    return text(404, "Not Found");
  };
}

/** Whether a publish request carries the configured bearer token. */
function authorizedPublish(request: Request, token: string): boolean {
  const header = request.headers.get("authorization");
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match !== null && timingSafeEqual(match[1] as string, token);
}

/** Constant-time string comparison so token checks do not leak length/content. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Fetch live usage counts from the DO for the NodeInfo document. */
async function nodeInfoUsage(
  config: ResolvedConfig,
  env: ActivityPubEnv,
): Promise<UsageCounts> {
  try {
    const statsUrl = `${config.iris.id}/__stats`;
    const response = await forwardToDo(config, env, statsUrl, {
      method: "GET",
    });
    if (!response.ok) return {};
    const stats = (await response.json()) as UsageCounts;
    return {
      users: typeof stats.users === "number" ? stats.users : 1,
      localPosts: typeof stats.localPosts === "number" ? stats.localPosts : 0,
    };
  } catch {
    return {};
  }
}
