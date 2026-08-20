/**
 * `@dwk/webmention` — Webmention (W3C) receiver + sender.
 *
 * Endpoint package. The receiver validates `source`/`target` synchronously,
 * returns `202 Accepted`, and enqueues the pair for asynchronous link
 * verification; the queue consumer fetches the source, confirms it links to the
 * target, and persists (or removes) the mention in an inbox. The sender
 * discovers a target's Webmention endpoint and notifies it on publish. Cloud
 * specifics (Queue, D1) are confined here; HTML scanning uses the runtime's
 * streaming `HTMLRewriter`, so the parsing/verification helpers are async and
 * exercised under the Workers test pool.
 *
 * @see spec/packages/webmention.md
 * @packageDocumentation
 */

import type {
  D1Database,
  ExecutionContext,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import {
  hostFromUrl,
  noopLogger,
  noopMetrics,
  type Logger,
  type Metrics,
} from "@dwk/log";
import type { FetchLike } from "@dwk/safe-fetch";
import { createD1Inbox, type InboxStore } from "./inbox.js";
import { WebmentionLogEvent } from "./log.js";
import { validateWebmentionParams } from "./validate.js";
import { verifySource, verifyVouch } from "./verify.js";

export {
  validateWebmentionParams,
  type ValidateParams,
  type ValidationResult,
  type WebmentionValidationError,
} from "./validate.js";
export {
  discoverEndpoint,
  findWebmentionEndpoint,
  type DiscoverOptions,
} from "./discovery.js";
export {
  sendWebmention,
  sendWebmentions,
  resendForDeletedSource,
  type SendOptions,
  type SendResult,
  type ResendOptions,
} from "./sender.js";
export {
  createD1SentLog,
  type SentLog,
  type D1SentLogOptions,
} from "./sent-log.js";
export {
  verifySource,
  sourceLinksTo,
  extractLinks,
  verifyVouch,
  type VerifyOptions,
  type VerifyResult,
  type VouchResult,
} from "./verify.js";
export {
  extractRsvp,
  isRsvpValue,
  RSVP_VALUES,
  type RsvpValue,
} from "./rsvp.js";
export {
  extractEnrichment,
  isInteractionType,
  INTERACTION_TYPES,
  CONTENT_MAX_TEXT_LENGTH,
  type InteractionType,
  type MentionAuthor,
  type MentionEnrichment,
} from "./enrich.js";
export {
  createD1Inbox,
  mentionId,
  type InboxStore,
  type VerifiedMention,
  type D1InboxOptions,
} from "./inbox.js";
export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "@dwk/safe-fetch";
export { WebmentionLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";

export { createWebmentionMcpTools } from "./mcp-tools.js";
export type { WebmentionMcpToolsConfig } from "./mcp-tools.js";

/** A queued verification job: confirm that `source` links to `target`. */
export interface WebmentionJob {
  readonly source: string;
  readonly target: string;
  /**
   * The sender's Vouch URL (indieweb.org/Vouch), when supplied and
   * syntactically a valid `http(s)` URL. Verified asynchronously alongside
   * `source`/`target` — see {@link verifyVouch} in `verify.ts`.
   */
  readonly vouch?: string;
}

/** Cloudflare bindings required by the Webmention handler and queue consumer. */
export interface WebmentionEnv {
  /** Queue producer for async verification of received mentions. */
  readonly WEBMENTION_QUEUE: Queue<WebmentionJob>;
  /**
   * D1 database backing the default inbox. Optional only when an
   * {@link InboxStore} is supplied via {@link WebmentionConfig.inbox} (e.g. a
   * Solid Pod DO-backed inbox).
   */
  readonly WEBMENTION_INBOX?: D1Database;
}

/** Configuration passed to {@link createWebmention}. */
export interface WebmentionConfig {
  /** Base URL of this receiver; a `target` must live under its origin. */
  readonly baseUrl: string;
  /** Additional controlled hostnames besides `baseUrl`'s. */
  readonly allowedHosts?: readonly string[];
  /**
   * Inbox store for verified mentions. Defaults to a D1 store built from
   * {@link WebmentionEnv.WEBMENTION_INBOX}; supply one to back the inbox with
   * the `@dwk/solid-pod` Durable Object instead.
   */
  readonly inbox?: InboxStore;
  /** `fetch` implementation for verification; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /**
   * Logger for receiver/queue events; defaults to a no-op. Wire a real logger
   * (see `@dwk/log`) to surface SSRF blocks, validation rejections, and
   * poison-message retries instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for receiver/queue counters; defaults to a no-op. Wire an
   * adapter (e.g. `analyticsEngineMetrics` from `@dwk/log`, bound to an
   * `AnalyticsEngineDataset`) to chart the same events the logger names —
   * "SSRF blocks/min", "verification success rate", "queue retries by reason".
   */
  readonly metrics?: Metrics;
  /**
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:4321"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
  /**
   * Whether a vouch URL's own hostname is one this receiver already trusts (indieweb.org/Vouch)
   * — checked before any vouch page is fetched. Omitted entirely means "nothing is trusted yet"
   * (every vouch verifies false, but the mention itself is unaffected — vouch is only ever a
   * bonus signal on top of source→target verification, never a gate on it), not "everything is
   * trusted." See {@link verifyVouch} in `verify.ts`.
   */
  readonly isTrustedVouchDomain?: (
    hostname: string,
  ) => boolean | Promise<boolean>;
}

/** A `fetch`-compatible Worker handler. */
export type WebmentionHandler = (
  request: Request,
  env: WebmentionEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** A Queue consumer for asynchronous Webmention verification. */
export type WebmentionQueueConsumer = (
  batch: MessageBatch<WebmentionJob>,
  env: WebmentionEnv,
  ctx: ExecutionContext,
) => Promise<void>;

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function resolveInbox(
  config: WebmentionConfig,
  env: WebmentionEnv,
): InboxStore {
  if (config.inbox !== undefined) {
    return config.inbox;
  }
  if (env.WEBMENTION_INBOX !== undefined) {
    return createD1Inbox(env.WEBMENTION_INBOX);
  }
  throw new Error(
    "@dwk/webmention: no inbox configured — provide config.inbox or bind " +
      "WEBMENTION_INBOX (D1).",
  );
}

function formValue(value: string | File | null): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Extract and validate the optional `vouch` form field. A missing or
 * syntactically invalid value returns `undefined` rather than an error —
 * Vouch is a supplementary trust signal (indieweb.org/Vouch), not a required
 * one, so a malformed vouch parameter must never turn into a whole-mention
 * rejection.
 */
function validVouchUrl(value: string | File | null): string | undefined {
  const raw = formValue(value);
  if (raw === null || raw === "") {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the request body is `application/x-www-form-urlencoded` — the encoding
 * Webmention §3.1.3 requires. `Request.formData()` would also accept
 * `multipart/form-data`, so the essence is checked up front rather than relying
 * on it.
 */
function isFormUrlEncoded(contentType: string | null): boolean {
  const essence = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "application/x-www-form-urlencoded";
}

/**
 * Build the Webmention receiver handler from configuration.
 *
 * The returned handler is mountable under any path prefix. It accepts a
 * form-encoded `POST` (`source` + `target`), validates synchronously, enqueues
 * the pair for verification, and returns `202 Accepted`. Invalid requests get
 * `400`; other methods get `405`. Fails loudly if the required `WEBMENTION_QUEUE`
 * binding is missing.
 */
export function createWebmention(config: WebmentionConfig): WebmentionHandler {
  const logger = config.logger ?? noopLogger;
  const metrics = config.metrics ?? noopMetrics;
  return async (request, env, _ctx) => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    if (env.WEBMENTION_QUEUE === undefined) {
      throw new Error(
        "@dwk/webmention: missing required binding WEBMENTION_QUEUE.",
      );
    }

    if (!isFormUrlEncoded(request.headers.get("content-type"))) {
      const fields = { reason: "invalid_content_type" as const };
      logger.warn(WebmentionLogEvent.ReceiveRejected, fields);
      metrics.count(WebmentionLogEvent.ReceiveRejected, fields);
      return textResponse(
        400,
        "invalid_request: Content-Type must be application/x-www-form-urlencoded",
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return textResponse(
        400,
        "invalid_request: expected a form-encoded body with source and target",
      );
    }

    const result = validateWebmentionParams({
      source: formValue(form.get("source")),
      target: formValue(form.get("target")),
      baseUrl: config.baseUrl,
      allowedHosts: config.allowedHosts,
    });
    if (!result.ok) {
      const fields = { reason: result.error };
      logger.warn(WebmentionLogEvent.ReceiveRejected, fields);
      metrics.count(WebmentionLogEvent.ReceiveRejected, fields);
      return textResponse(400, result.error);
    }

    const vouch = validVouchUrl(form.get("vouch"));

    await env.WEBMENTION_QUEUE.send({
      source: result.source,
      target: result.target,
      ...(vouch !== undefined ? { vouch } : {}),
    });

    const fields = {
      sourceHost: hostFromUrl(result.source),
      targetHost: hostFromUrl(result.target),
    };
    logger.info(WebmentionLogEvent.ReceiveAccepted, fields);
    metrics.count(WebmentionLogEvent.ReceiveAccepted, fields);
    return new Response(null, { status: 202 });
  };
}

/** Base delay (seconds) before the first queue retry, doubled per attempt. */
const RETRY_BASE_DELAY_SECONDS = 30;
/** Ceiling on the retry delay (seconds), regardless of attempt count. */
const RETRY_MAX_DELAY_SECONDS = 3600;

/**
 * Exponential backoff (base {@link RETRY_BASE_DELAY_SECONDS}, doubling per
 * attempt, capped at {@link RETRY_MAX_DELAY_SECONDS}) for a queue message's
 * `retry({ delaySeconds })`. A bare `message.retry()` with no delay would
 * re-deliver an unreachable source at the queue's default cadence
 * indefinitely, hammering it instead of backing off.
 */
function retryDelaySeconds(attempts: number): number {
  // Defensively clamp to a valid attempt count: real Cloudflare Queue
  // messages always report attempts >= 1, but a test double or a future
  // platform change reporting 0/undefined/NaN must not compute a NaN delay.
  const safeAttempts =
    Number.isFinite(attempts) && attempts >= 1 ? attempts : 1;
  return Math.min(
    RETRY_BASE_DELAY_SECONDS * 2 ** (safeAttempts - 1),
    RETRY_MAX_DELAY_SECONDS,
  );
}

/**
 * Build the Queue consumer that verifies received mentions.
 *
 * For each job it fetches the source and checks for a link to the target: a
 * verified mention is upserted into the inbox, while a source that no longer
 * links is removed. A job that throws is retried; otherwise it is acked. Fails
 * loudly if no inbox is configured.
 */
export function createWebmentionQueueConsumer(
  config: WebmentionConfig,
): WebmentionQueueConsumer {
  const logger = config.logger ?? noopLogger;
  const metrics = config.metrics ?? noopMetrics;
  return async (batch, env, _ctx) => {
    const inbox = resolveInbox(config, env);
    for (const message of batch.messages) {
      const { source, target, vouch } = message.body;
      try {
        const result = await verifySource(source, target, {
          fetch: config.fetch,
          logger,
          metrics,
          fetchAllowedHosts: config.fetchAllowedHosts,
        });
        if (result.links) {
          const verifiedAt = Date.now();
          // `dt-published` when the entry declares (and we can parse) it,
          // else the verification time — the field is always populated.
          const publishedMs =
            result.published !== undefined
              ? Date.parse(result.published)
              : Number.NaN;
          // Vouch only runs once the mention itself has verified — it is a
          // trust signal on top of a real mention, never a substitute for one.
          // `url` is captured alongside the outcome (rather than read from
          // the outer `vouch` separately) so its non-optional-ness is tied to
          // `vouchOutcome`'s own presence for the type checker.
          const vouchOutcome =
            vouch !== undefined
              ? {
                  url: vouch,
                  verified: (
                    await verifyVouch(
                      vouch,
                      source,
                      config.isTrustedVouchDomain ?? (() => false),
                      {
                        fetch: config.fetch,
                        logger,
                        metrics,
                        fetchAllowedHosts: config.fetchAllowedHosts,
                      },
                    )
                  ).verified,
                }
              : undefined;
          await inbox.store({
            source,
            target,
            verifiedAt,
            interactionType: result.interactionType ?? "mention",
            ...(result.author !== undefined ? { author: result.author } : {}),
            ...(result.content !== undefined
              ? { content: result.content }
              : {}),
            publishedAt: Number.isFinite(publishedMs)
              ? publishedMs
              : verifiedAt,
            ...(result.rsvp !== undefined ? { rsvp: result.rsvp } : {}),
            ...(vouchOutcome !== undefined ? { vouch: vouchOutcome } : {}),
          });
        } else {
          await inbox.remove(source, target);
        }
        message.ack();
      } catch (err) {
        // A poison message must not retry silently — record why so an operator
        // can tell a transient failure from a wedged one.
        const fields = {
          sourceHost: hostFromUrl(source),
          targetHost: hostFromUrl(target),
          error: err instanceof Error ? err.name : "unknown",
        };
        logger.warn(WebmentionLogEvent.QueueRetry, fields);
        metrics.count(WebmentionLogEvent.QueueRetry, fields);
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  };
}
