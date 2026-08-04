/**
 * The Microsub fetch handler: a single endpoint whose `action` (and `method`)
 * parameters select the operation — channel management, following, the JF2
 * timeline, search, and preview — wired to the D1 store and `@dwk/indieauth`
 * token validation. Routing matches the request pathname against the configured
 * endpoint path, so the handler is mountable under any prefix.
 *
 * The read path serves stored entries only; it never fetches a source inline.
 * Following a feed discovers it, populates the timeline from the discovery
 * fetch, and enqueues a poll job so the feed's poll cache is primed.
 *
 * @packageDocumentation
 */

import type { ExecutionContext } from "@cloudflare/workers-types";

import {
  authorize,
  tokenFromHeader,
  type AuthEnv,
  type AuthResult,
} from "./auth.js";
import {
  resolveConfig,
  type MicrosubConfig,
  type MicrosubEnv,
  type ResolvedConfig,
} from "./config.js";
import { discoverFeed } from "./discovery.js";
import { orderEntriesForInsert } from "./jf2.js";
import { MicrosubLogEvent } from "./log.js";
import {
  createMicrosubStore,
  NOTIFICATIONS_CHANNEL,
  type MicrosubStore,
} from "./store.js";

/** A `fetch`-compatible Worker handler. */
export type MicrosubHandler = (
  request: Request,
  env: MicrosubEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, DPoP, Content-Type",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/** A Microsub error body (`{ error, error_description }`) at `status`. */
function error(code: string, description: string, status: number): Response {
  return json({ error: code, error_description: description }, status);
}

function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: Record<string, unknown>,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/** Fail loudly when a required binding is absent (composition contract). */
function assertBindings(env: MicrosubEnv): void {
  if (!env.MICROSUB_DB) {
    throw new Error("@dwk/microsub: missing required D1 binding `MICROSUB_DB`");
  }
  if (!env.MICROSUB_QUEUE) {
    throw new Error("@dwk/microsub: missing required binding `MICROSUB_QUEUE`");
  }
  if (!env.AUTH_DB) {
    throw new Error(
      "@dwk/microsub: missing required D1 binding `AUTH_DB` (IndieAuth token store)",
    );
  }
  if (!env.TOKEN_SIGNING_KEY || typeof env.TOKEN_SIGNING_KEY !== "string") {
    throw new Error(
      "@dwk/microsub: missing required secret binding `TOKEN_SIGNING_KEY`",
    );
  }
}

/** Merge the query string and (for POST) the form/JSON body into one param bag. */
async function readParams(
  request: Request,
  method: string,
): Promise<URLSearchParams> {
  const params = new URLSearchParams(new URL(request.url).search);
  if (method !== "POST") return params;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (body && typeof body === "object") {
        for (const [key, value] of Object.entries(body)) {
          if (Array.isArray(value)) {
            for (const v of value) params.append(key, String(v));
          } else if (value !== null && value !== undefined) {
            params.append(key, String(value));
          }
        }
      }
    } catch {
      // malformed JSON: fall through with query-only params.
    }
  } else {
    try {
      const form = await request.formData();
      for (const [key, value] of form) {
        if (typeof value === "string") params.append(key, value);
      }
    } catch {
      // malformed/empty body: query-only params.
    }
  }
  return params;
}

/** All values for a param under both its bare and `[]` array spellings. */
function getAll(params: URLSearchParams, name: string): string[] {
  return [...params.getAll(name), ...params.getAll(`${name}[]`)];
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Authorize a request, emitting an `AuthRejected` event on failure. The token is
 * taken from the `Authorization` header, falling back to an `access_token`
 * parameter (which Microsub clients may use), but never both.
 */
async function requireAuth(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  scopes: readonly string[],
  recordReplay: boolean,
): Promise<AuthResult> {
  const headerToken = tokenFromHeader(request);
  const paramToken = params.get("access_token");
  if (headerToken !== null && paramToken !== null) {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "the access token must be supplied via exactly one method, not both the `Authorization` header and a parameter",
      status: 400,
    };
  }
  const auth = await authorize(
    request,
    env as AuthEnv,
    config,
    headerToken ?? paramToken,
    scopes,
    recordReplay,
    config.microsubEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicrosubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
  }
  return auth;
}

function authError(auth: Extract<AuthResult, { ok: false }>): Response {
  return error(auth.error, auth.description, auth.status);
}

// --- Channels ---------------------------------------------------------------

async function handleChannelsGet(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, [], false);
  if (!auth.ok) return authError(auth);

  const channels = await store.listChannels();
  const withUnread = await Promise.all(
    channels.map(async (channel) => ({
      uid: channel.uid,
      name: channel.name,
      unread: await store.unreadCount(channel.uid),
    })),
  );
  return json({ channels: withUnread });
}

async function handleChannelsPost(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(
    request,
    env,
    config,
    params,
    ["channels"],
    true,
  );
  if (!auth.ok) return authError(auth);

  const method = params.get("method");
  const channel = params.get("channel");

  if (method === "delete") {
    if (!channel) return rejected(config, "missing_channel");
    if (channel === NOTIFICATIONS_CHANNEL) {
      return rejected(config, "reserved_channel");
    }
    const ok = await store.deleteChannel(channel);
    if (!ok) return error("invalid_request", "no such channel", 404);
    emit(config, "info", MicrosubLogEvent.ActionCompleted, {
      action: "channels",
      method: "delete",
    });
    return json({});
  }

  if (method === "order") {
    const order = getAll(params, "channels");
    await store.reorderChannels(order);
    const channels = await store.listChannels();
    emit(config, "info", MicrosubLogEvent.ActionCompleted, {
      action: "channels",
      method: "order",
    });
    return json({
      channels: channels.map((c) => ({ uid: c.uid, name: c.name })),
    });
  }

  const name = params.get("name");
  if (!name) return rejected(config, "missing_name");

  if (channel) {
    const updated = await store.renameChannel(channel, name);
    if (!updated) {
      return error(
        "invalid_request",
        channel === NOTIFICATIONS_CHANNEL
          ? "the notifications channel cannot be renamed"
          : "no such channel",
        channel === NOTIFICATIONS_CHANNEL ? 400 : 404,
      );
    }
    emit(config, "info", MicrosubLogEvent.ActionCompleted, {
      action: "channels",
      method: "update",
    });
    return json({ uid: updated.uid, name: updated.name });
  }

  const created = await store.createChannel(name, now());
  emit(config, "info", MicrosubLogEvent.ActionCompleted, {
    action: "channels",
    method: "create",
  });
  return json({ uid: created.uid, name: created.name });
}

// --- Following --------------------------------------------------------------

async function handleFollowGet(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, [], false);
  if (!auth.ok) return authError(auth);

  const channel = params.get("channel");
  if (!channel) return rejected(config, "missing_channel");
  if (!(await store.channelExists(channel))) {
    return error("invalid_request", "no such channel", 404);
  }
  const follows = await store.listFollows(channel);
  return json({
    items: follows.map((follow) => ({ type: "feed", url: follow.pageUrl })),
  });
}

async function handleFollow(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await requireAuth(
    request,
    env,
    config,
    params,
    ["follow", "channels"],
    true,
  );
  if (!auth.ok) return authError(auth);

  const channel = params.get("channel");
  const url = params.get("url");
  if (!channel) return rejected(config, "missing_channel");
  if (!url) return rejected(config, "missing_url");
  if (!(await store.channelExists(channel))) {
    return error("invalid_request", "no such channel", 404);
  }

  const discovered = await discoverFeed(url, {
    fetch: config.fetch,
    logger: config.logger,
    metrics: config.metrics,
    fetchAllowedHosts: config.fetchAllowedHosts,
  });
  const feedUrl = discovered?.feedUrl ?? url;
  await store.addFollow(channel, feedUrl, url, now());

  if (discovered && discovered.entries.length > 0) {
    // Populate the timeline immediately so the user does not wait for the next
    // scheduled poll.
    const ordered = orderEntriesForInsert(discovered.entries);
    await store.insertItems(
      channel,
      feedUrl,
      ordered,
      now(),
      config.maxItemsPerChannel,
    );
  }
  // Prime the poll cache and pick up anything discovery did not.
  ctx.waitUntil(env.MICROSUB_QUEUE.send({ kind: "poll", feedUrl }));

  emit(config, "info", MicrosubLogEvent.ActionCompleted, { action: "follow" });
  return json({ type: "feed", url });
}

async function handleUnfollow(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(
    request,
    env,
    config,
    params,
    ["follow", "channels"],
    true,
  );
  if (!auth.ok) return authError(auth);

  const channel = params.get("channel");
  const url = params.get("url");
  if (!channel) return rejected(config, "missing_channel");
  if (!url) return rejected(config, "missing_url");
  await store.removeFollow(channel, url);
  emit(config, "info", MicrosubLogEvent.ActionCompleted, {
    action: "unfollow",
  });
  return json({});
}

// --- Timeline ---------------------------------------------------------------

async function handleTimelineGet(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, [], false);
  if (!auth.ok) return authError(auth);

  const channel = params.get("channel");
  if (!channel) return rejected(config, "missing_channel");
  if (!(await store.channelExists(channel))) {
    return error("invalid_request", "no such channel", 404);
  }

  const before = params.get("before") ?? undefined;
  const after = params.get("after") ?? undefined;
  const page = await store.listItems(channel, {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    limit: config.pageSize,
  });

  const paging: { before?: string; after?: string } = {};
  if (page.before !== undefined) paging.before = page.before;
  if (page.after !== undefined) paging.after = page.after;
  return json({ items: page.items.map((item) => item.entry), paging });
}

async function handleTimelinePost(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, ["read"], true);
  if (!auth.ok) return authError(auth);

  const method = params.get("method");
  const channel = params.get("channel");
  if (!channel) return rejected(config, "missing_channel");
  const entries = getAll(params, "entry");
  const lastRead = params.get("last_read_entry");

  switch (method) {
    case "mark_read":
      if (lastRead) await store.markReadThrough(channel, lastRead);
      else await store.markRead(channel, entries, true);
      break;
    case "mark_unread":
      await store.markRead(channel, entries, false);
      break;
    case "remove":
      for (const entry of entries) await store.removeItem(channel, entry);
      break;
    default:
      return rejected(config, "unknown_method");
  }
  emit(config, "info", MicrosubLogEvent.ActionCompleted, {
    action: "timeline",
    method: method ?? "",
  });
  return json({});
}

// --- Search / preview -------------------------------------------------------

async function handlePreview(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, [], false);
  if (!auth.ok) return authError(auth);

  const url = params.get("url");
  if (!url) return rejected(config, "missing_url");
  const discovered = await discoverFeed(url, {
    fetch: config.fetch,
    logger: config.logger,
    metrics: config.metrics,
    fetchAllowedHosts: config.fetchAllowedHosts,
  });
  const items = (discovered?.entries ?? []).slice(0, config.pageSize);
  return json({ items });
}

async function handleSearch(
  request: Request,
  env: MicrosubEnv,
  config: ResolvedConfig,
  params: URLSearchParams,
  store: MicrosubStore,
): Promise<Response> {
  const auth = await requireAuth(request, env, config, params, [], false);
  if (!auth.ok) return authError(auth);

  const query = (params.get("query") ?? "").trim();
  const channel = params.get("channel");

  if (channel) {
    if (!(await store.channelExists(channel))) {
      return error("invalid_request", "no such channel", 404);
    }
    const results = await store.searchItems(channel, query, config.pageSize);
    return json({ items: results.map((item) => item.entry) });
  }

  if (query === "") return rejected(config, "missing_query");
  // Feed search: we have no third-party feed index, so a URL-shaped query is
  // resolved through discovery; anything else returns no results.
  const results: Array<{ type: "feed"; url: string }> = [];
  if (/^https?:\/\//i.test(query)) {
    const discovered = await discoverFeed(query, {
      fetch: config.fetch,
      logger: config.logger,
      metrics: config.metrics,
      fetchAllowedHosts: config.fetchAllowedHosts,
    });
    if (discovered) results.push({ type: "feed", url: discovered.feedUrl });
  }
  return json({ results });
}

function rejected(config: ResolvedConfig, reason: string): Response {
  emit(config, "warn", MicrosubLogEvent.RequestRejected, { reason });
  const messages: Record<string, string> = {
    missing_channel: "`channel` is required",
    missing_url: "`url` is required",
    missing_name: "`name` is required",
    missing_query: "`query` is required",
    reserved_channel: "the notifications channel cannot be deleted",
    unknown_method: "unsupported `method`",
    unknown_action: "unsupported `action`",
  };
  const status = reason === "reserved_channel" ? 400 : 400;
  return error(
    "invalid_request",
    messages[reason] ?? "invalid request",
    status,
  );
}

// --- Entry point ------------------------------------------------------------

/**
 * Create the Microsub handler. The returned handler routes by pathname against
 * the configured endpoint URL, so it is mountable under any path prefix, then
 * dispatches on the `action` (and `method`) parameters.
 */
export function createMicrosub(config: MicrosubConfig): MicrosubHandler {
  const resolved = resolveConfig(config);

  return async (request, env, ctx) => {
    assertBindings(env);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (pathname !== resolved.microsubPath) {
      return new Response("Not Found", { status: 404 });
    }
    if (method !== "GET" && method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, POST, OPTIONS", ...CORS_HEADERS },
      });
    }

    const params = await readParams(request, method);
    const action = params.get("action") ?? "";
    const store = createMicrosubStore(env);

    if (method === "GET") {
      switch (action) {
        case "channels":
          return handleChannelsGet(request, env, resolved, params, store);
        case "timeline":
          return handleTimelineGet(request, env, resolved, params, store);
        case "follow":
          return handleFollowGet(request, env, resolved, params, store);
        case "preview":
          return handlePreview(request, env, resolved, params);
        case "search":
          return handleSearch(request, env, resolved, params, store);
        default:
          return rejected(resolved, "unknown_action");
      }
    }

    switch (action) {
      case "channels":
        return handleChannelsPost(request, env, resolved, params, store);
      case "follow":
        return handleFollow(request, env, resolved, params, store, ctx);
      case "unfollow":
        return handleUnfollow(request, env, resolved, params, store);
      case "timeline":
        return handleTimelinePost(request, env, resolved, params, store);
      case "search":
        return handleSearch(request, env, resolved, params, store);
      default:
        return rejected(resolved, "unknown_action");
    }
  };
}
