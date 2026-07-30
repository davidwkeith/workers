/**
 * The per-actor Durable Object: the single-threaded consistency authority for
 * one ActivityPub actor.
 *
 * The stateless front door (`handler.ts`) verifies inbound HTTP signatures at
 * the edge and hands the verified facts to this object via internal headers;
 * everything that must be strongly consistent — activity-`id` dedup, the
 * follower/following collections, the outbox, and the signed outbound delivery
 * queue — happens here, where Cloudflare guarantees a single thread per actor.
 * Delivery retries are driven by the DO **alarm** with exponential backoff.
 * Consumers bind this class as a Durable Object namespace.
 */

import { DurableObject } from "cloudflare:workers";

import {
  AS2_CONTENT_TYPE,
  PUBLIC_AUDIENCE,
  actorIri,
  buildCollection,
  buildCollectionPage,
  objectId,
  objectType,
  type ActivityObject,
  type ActorIris,
  type JsonValue,
} from "./as2.js";
import { hostFromUrl } from "@dwk/log";
import { readBodyCapped, safeFetch } from "@dwk/safe-fetch";

import {
  ApOutcome,
  ActivityPubLogEvent,
  METRICS_DRAIN_HEADER,
  METRICS_HEADER,
  OUTCOME_ACTIVITY_HEADER,
  OUTCOME_HEADER,
  type PendingMetric,
} from "./log.js";
import { participationTarget } from "./events.js";
import {
  buildAnnounceActivity,
  buildPostActivity,
  classifyActivity,
  isValidPublished,
  parsePostInput,
  type PostInput,
} from "./objects.js";
import { INTERNAL_HEADERS, type ForwardedConfig } from "./config.js";
import {
  assertPublicHttpsTarget,
  deliverActivity,
  DeliveryBlockedError,
} from "./delivery.js";
import type { ActivityPubEnv } from "./config.js";

/** How long a seen activity `id` is remembered for dedup (7 days). */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Max delivery rows processed per alarm wake. */
const DELIVERY_BATCH = 20;
/** Timeout (ms) bounding any single outbound fetch (actor lookup / delivery). */
const OUTBOUND_TIMEOUT_MS = 10_000;
/** The embedded activity kinds a FEP-1b12 group announce may relay (§2.2). */
const RELAYED_ACTIVITY_TYPES = [
  "Create",
  "Update",
  "Delete",
  "Like",
  "Dislike",
];
/** How long relayed votes wait for their batched verification sweep (§2.2). */
const VOTE_SWEEP_MS = 10 * 60_000;
/** Small debounce before a newly seen actor document is hydrated. */
const ACTOR_PROFILE_DEBOUNCE_MS = 1_000;
/** Actor documents are optional display metadata; keep their cache well below a DO SQLite cell. */
const ACTOR_PROFILE_MAX_BODY_BYTES = 128 * 1024;
/**
 * Hard cap on batches scanned per client-list page in `#serveClientList`,
 * both for the inbox (notifications: favourite/reblog/mention) and for the
 * outbox owner-post merge into the timeline. Without it, an inbox or outbox
 * dominated by unwanted activity types (plain Create/Update rows for
 * notifications; Like/Announce/etc. for the timeline merge) forces a
 * near-full-table scan per request; past this cap the page simply returns
 * fewer than `limit` matches rather than exhausting the table.
 */
const MAX_SCAN_BATCHES = 25;
/**
 * Cardinality cap on the pending-metrics table: at most this many distinct
 * `(event, fields)` keys accumulate between drains. Delivery fields include
 * the target host and attempt number, so a large follower set could otherwise
 * grow the table without bound while the front door is quiet; at the cap, new
 * keys tally into a single overflow counter instead (loss of attribution, not
 * of count).
 */
const MAX_PENDING_METRIC_ROWS = 256;
/** Max distinct deltas drained per response (bounds the header size). */
const DRAIN_ROW_LIMIT = 32;
/**
 * Max total occurrences drained per response: the front door replays each
 * drained delta as `n` individual `Metrics.count` calls, so this bounds the
 * per-request replay burst. A backlog larger than this drains over successive
 * requests (rows are decremented, not dropped).
 */
const DRAIN_COUNT_BUDGET = 256;

function json(
  status: number,
  body: JsonValue,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": AS2_CONTENT_TYPE, ...headers },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Whether an owner-published activity is a **single-target relationship**
 * activity (#447, #473) — one aimed at a single actor's relationship with
 * this one, rather than content for the follower set: `Reject` (of a
 * `Follow`), `Block`, `Undo(Block)`, and `Accept` (confirming a pending
 * follower).
 *
 * Every `Reject`/`Accept` qualifies, not only one carrying a well-formed
 * `Follow`: the failure this guards against is a control activity leaking
 * into the follower fan-out, so an unroutable one is claimed here and
 * dropped rather than broadcast. `Reject`/`Accept` of an event `Join` is not
 * a case this actor can produce — manual `Join` approval is out of scope
 * for v1 (spec §"Events & RSVPs").
 */
function isFollowerControlActivity(
  activity: Record<string, JsonValue>,
): boolean {
  if (
    activity.type === "Block" ||
    activity.type === "Reject" ||
    activity.type === "Accept"
  ) {
    return true;
  }
  return (
    activity.type === "Undo" &&
    objectType(activity.object as JsonValue) === "Block"
  );
}

/**
 * Address a follower-control activity to its single recipient (#447). The owner
 * may have sent it carrying `cc: [<followers>]` or a public `to` copied from an
 * ordinary post; delivering privately while the body claims a wider audience
 * would misdescribe what happened to the one server that receives it.
 */
function addressPrivately(
  activity: Record<string, JsonValue>,
  target: string,
): void {
  activity.to = [target];
  delete activity.cc;
  delete activity.bto;
  delete activity.bcc;
  delete activity.audience;
}

/** Cheap, local (no network) check so an unsafe actor IRI never reaches the queue. */
function isSafeTarget(actor: string): boolean {
  try {
    assertPublicHttpsTarget(actor);
    return true;
  } catch {
    return false;
  }
}

export class ActivityPubObject extends DurableObject<ActivityPubEnv> {
  readonly #sql: SqlStorage;
  #config: ForwardedConfig | null = null;

  constructor(state: DurableObjectState, env: ActivityPubEnv) {
    super(state, env);
    this.#sql = state.storage.sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    );
    // `follow_id` is the inbound `Follow` activity's own IRI, kept so an
    // owner-published `Reject` can name the very activity it rejects (#447);
    // NULL when the follower arrived without one (or via the FEP-1b12 `Join`
    // membership synonym).
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS followers (
         actor TEXT PRIMARY KEY, inbox TEXT, added_at INTEGER NOT NULL,
         shared_inbox TEXT, follow_id TEXT)`,
    );
    // `actor_type` is the followed actor's AS2 type (`Person`, `Group`, …),
    // resolved from its actor document off the critical path; a `Group` row is
    // what qualifies its Announces for FEP-1b12 unwrapping (§2.2). NULL means
    // "not yet resolved" (lazily backfilled); 'Unknown' means resolution
    // permanently failed (never re-tried, never a Group).
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS following (
         actor TEXT PRIMARY KEY, state TEXT NOT NULL, added_at INTEGER NOT NULL,
         actor_type TEXT, inbox TEXT, shared_inbox TEXT)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`,
    );
    // `relayed_by` marks group-relayed (Announce-unwrapped) content — never
    // confusable with directly-signed activities — and `verify_state` tracks
    // its async origin verification: NULL (direct), 'pending', or 'verified'
    // (a failed verification deletes the row). See §2.2.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS inbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, json TEXT NOT NULL,
         received_at INTEGER NOT NULL, object_type TEXT, audience TEXT,
         relayed_by TEXT, verify_state TEXT)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS outbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, json TEXT NOT NULL,
         published_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_outbox_published_at ON outbox (published_at, seq)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS delivery (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, inbox TEXT NOT NULL, json TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)`,
    );
    // Auto-`Accept` (Follow/Join) whose target inbox is not yet resolved. The
    // resolution (an outbound actor-document fetch) runs from the alarm, not
    // inline on the inbound POST — see #resolveInbox / #processPendingAccepts.
    // `event` is only set for a `join` row (the RSVP's target), so a Leave that
    // lands before the alarm runs can be detected without parsing `json`.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS pending_accept (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, actor TEXT NOT NULL,
         event TEXT, json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
         next_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_accept_next_at ON pending_accept (next_at)`,
    );
    // Event RSVPs (#171): one row per (event, participant). `status` is
    // 'accepted' (auto-accepted, or after a manual Accept) or 'pending'
    // (awaiting manual approval). A Leave deletes the row.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS attendees (
         event TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
         added_at INTEGER NOT NULL, PRIMARY KEY (event, actor))`,
    );
    // `Group`-hosting moderation (#376): an actor banned here (by a
    // moderator-signed `Remove` targeting `followers`) is dropped as a
    // follower and every subsequent activity it sends is rejected outright —
    // see `#isBanned` / `#onModerationRemove`. Meaningless for a `Person`
    // actor (never populated).
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS banned (
         actor TEXT PRIMARY KEY, banned_at INTEGER NOT NULL)`,
    );
    // Owner blocklist (#447): an actor the owner blocked through the
    // follower-control publish path. Unlike `banned` (a `Group` moderator
    // decision, moderator-signed over the inbox) this is the actor owner's own
    // decision for any actor type, and it is reversible — an owner-published
    // `Undo(Block)` deletes the row. Consulted on every inbound activity, so a
    // blocked actor can neither re-follow nor reach the inbox at all.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS blocked (
         actor TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL)`,
    );
    // Async origin verification of group-relayed activities (§2.2): one row
    // per stored relayed activity awaiting verification. `target` is the IRI
    // fetched from its origin; `expect` is 'present' (2xx + id match),
    // 'gone' (404/410 confirms a relayed Delete), or 'vote' (like 'present',
    // but a 404 is inconclusive — vote IRIs are often not public). Terminal
    // outcomes delete the row; a *refutation* also deletes the inbox row.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS verify_queue (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, activity_id TEXT NOT NULL,
         target TEXT NOT NULL, expect TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)`,
    );
    // Remote actor documents used only to enrich the optional Mastodon client
    // API. They are populated from the alarm, never from a client request, so
    // a slow peer cannot hold the actor's input gate while a timeline renders.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS actor_cache (
         actor TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS actor_profile_queue (
         actor TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
         next_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_actor_profile_queue_next_at
         ON actor_profile_queue (next_at)`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_verify_queue_next_at ON verify_queue (next_at)`,
    );
    // Counter deltas for alarm-driven work (delivery outcomes), accumulated
    // here because the DO cannot call the injected `Metrics` seam across the
    // isolate boundary; drained to the front door via a response header on the
    // next forwarded request (see #drainPendingMetrics). `fields` is the
    // canonical (sorted-key) JSON of the same field bag the log line carries,
    // so identical outcomes coalesce into one row.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS pending_metrics (
         event TEXT NOT NULL, fields TEXT NOT NULL, n INTEGER NOT NULL,
         PRIMARY KEY (event, fields))`,
    );
    // Additive-column migrations for objects created before fediverse interop
    // phases 1–2 (#274/#275); fresh objects already get these from the CREATE
    // TABLEs above. Nullable by design: `object_type`/`audience` classify
    // stored inbound activities for reads (never validation), `relayed_by`/
    // `verify_state` carry relay provenance (§2.2), `shared_inbox` lets
    // fan-out batch per instance, and the `following` columns type the follow
    // target for FEP-1b12 (§2.1).
    this.#ensureColumn("inbox", "object_type", "TEXT");
    this.#ensureColumn("inbox", "audience", "TEXT");
    this.#ensureColumn("inbox", "relayed_by", "TEXT");
    this.#ensureColumn("inbox", "verify_state", "TEXT");
    // Set when a moderator un-announces a member post (#376 remove-post); a
    // non-NULL value tombstones the row for reads without deleting history.
    this.#ensureColumn("inbox", "removed_at", "INTEGER");
    this.#ensureColumn("followers", "shared_inbox", "TEXT");
    // The rejected `Follow`'s own IRI, for owner follower-control (#447).
    this.#ensureColumn("followers", "follow_id", "TEXT");
    this.#ensureColumn("following", "actor_type", "TEXT");
    this.#ensureColumn("following", "inbox", "TEXT");
    this.#ensureColumn("following", "shared_inbox", "TEXT");
    // Owner-admin follow confirmation (#473): NULL means still awaiting the
    // owner's `Accept`; non-NULL (the timestamp) means confirmed — either
    // auto-accepted at insert time (#onFollow) or owner-triggered later
    // (#routeFollowerControl's Accept branch). Every pre-existing row
    // predates this column and has no other stored signal of whether it was
    // genuinely still pending at migration time; backfilling all of them to
    // "already settled" (their `added_at`) avoids surfacing years of
    // ordinary auto-accepted followers as false "pending" requests. This
    // must run only the one time the column is actually added — never on
    // every cold start, or it would silently re-confirm every currently-
    // pending follower on every restart.
    if (this.#ensureColumn("followers", "accepted_at", "INTEGER")) {
      this.#sql.exec(
        `UPDATE followers SET accepted_at = added_at WHERE accepted_at IS NULL`,
      );
    }
  }

  /**
   * Add a nullable column if this object predates it (additive migration).
   * Checks `PRAGMA table_info` first (matching `@dwk/store`'s pattern) rather
   * than attempting the `ALTER TABLE` and pattern-matching the error string
   * for "duplicate column" — a substring match would silently swallow an
   * unrelated SQLite error (e.g. a disk-full write failure) that happens to
   * mention "duplicate column" in its own message, or miss a legitimate
   * duplicate-column error phrased differently by a future SQLite version.
   * Returns whether the column was just added, so a caller can run a
   * one-time backfill exactly once (see the `followers.accepted_at` call
   * site below) rather than on every constructor invocation.
   */
  #ensureColumn(table: string, column: string, type: string): boolean {
    const columns = this.#sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (columns.some((c) => c.name === column)) return false;
    this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    const config = this.#readConfig(request);
    if (!config) return text(500, "missing internal config");
    this.#config = config;
    this.#persistDeliveryConfig(config);

    const response = await this.#route(request, config);
    // Alarm-driven work (delivery retries) has no request of its own, so its
    // counter deltas accumulate in SQLite and ride out on the next forwarded
    // request whose caller opted in to relay them (the front door does, on
    // every request it forwards; see handler.ts). Opt-in keeps a caller that
    // would not relay the header (the MCP tools) from consuming the deltas.
    if (request.headers.get(METRICS_DRAIN_HEADER) !== "1") return response;
    const pending = this.#drainPendingMetrics();
    if (pending.length === 0) return response;
    const headers = new Headers(response.headers);
    headers.set(METRICS_HEADER, JSON.stringify(pending));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async #route(request: Request, config: ForwardedConfig): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const iris = config.iris;
    const method = request.method.toUpperCase();

    // Internal routes the front door constructs (never reachable externally).
    if (path === `${pathOf(iris.id)}/__stats`) return this.#stats();
    if (path === `${pathOf(iris.id)}/__resolve`) {
      const resolved = await this.#processPendingAccepts();
      return json(200, { processed: resolved });
    }
    if (path === `${pathOf(iris.id)}/__deliver`) {
      // Resolve due auto-Accepts first so a newly-resolved inbox is attempted
      // in this same pass (see `alarm()`).
      const resolved = await this.#processPendingAccepts();
      const due = await this.#processDeliveries();
      const verified = await this.#processVerifications();
      const profiles = await this.#processActorProfiles();
      return json(200, { processed: due + resolved + verified + profiles });
    }
    // Owner-only inbox listing for the `@dwk/mcp` tool contribution
    // (`activitypub_list_inbox`). Distinct from `iris.inbox`, which stays
    // write-only to peers (§7.1). This internal route has no public front-door
    // equivalent, so it is gated by an explicit internal marker (defense in
    // depth): even if a future front-door route forwarded this path, the DO
    // refuses it — `404`, as if the route did not exist — without the marker
    // the trusted MCP/syndication callers set.
    if (path === `${pathOf(iris.id)}/__inbox`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listInbox(request);
    }
    // Owner-only typed following listing (internal, like `__inbox`): accepted
    // follows with their resolved actor_type, for the community syndication
    // targets (§2.4 / #278) and future owner reads. `?type=Group` filters.
    if (path === `${pathOf(iris.id)}/__following`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listFollowing(request);
    }
    // Owner-only pending-follower listing (internal, like `__following`):
    // backs @dwk/mastodon-api's GET /api/v1/follow_requests (#473).
    if (path === `${pathOf(iris.id)}/__client/follow_requests`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listFollowRequests();
    }
    // Owner-only cursor-paginated reads for the Mastodon client API phase 2
    // (`@dwk/mastodon-api`'s `MastodonBackend` seam, #349): timeline (posts
    // from followed accounts), notifications (favourite/reblog/mention), and
    // a single-row lookup for `statuses/:id`. Internal-only like `__inbox`.
    if (path === `${pathOf(iris.id)}/__client/timeline`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listClientEntries(request, "timeline");
    }
    if (path === `${pathOf(iris.id)}/__client/notifications`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listClientEntries(request, "notifications");
    }
    if (path === `${pathOf(iris.id)}/__client/entry`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#clientEntry(request);
    }
    if (path === `${pathOf(iris.id)}/__client/actor`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#clientActor(request);
    }
    // Owner-write path for the Mastodon client API (`POST /api/v1/statuses`).
    // Internal + publish markers required, exactly like `/publish`; the
    // mastodon-api layer enforces the owner bearer + `write` scope upstream.
    if (path === `${pathOf(iris.id)}/__client/publish`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#clientPublish(request);
    }

    if (path === pathOf(iris.followers)) {
      return this.#serveCollection(request, iris.followers, "followers");
    }
    if (path === pathOf(iris.following)) {
      return this.#serveCollection(request, iris.following, "following");
    }
    if (path === pathOf(iris.outbox)) {
      if (method === "POST") return this.#publish(request);
      return this.#serveCollection(request, iris.outbox, "outbox");
    }
    // Owner shaped-post publish (`PostInput` → Create(Note|Article|Page)); the
    // outbox POST above stays purely AS2 (spec/fediverse-interop.md).
    if (path === `${pathOf(iris.id)}/publish`) {
      if (method === "POST") return this.#publishPost(request);
      return text(405, "Method Not Allowed");
    }
    // Owner blocklist read (#447). Not an AS2 collection and never public: the
    // owner's blocks are private, so this is gated by the same owner marker the
    // publish endpoints carry — the front door only sets it after checking the
    // publish bearer token.
    //
    // One rule, deliberately: anything that is not an authorized `GET` is
    // `404`, never `405`. A `405` would confirm the route exists to anyone who
    // probed it with the wrong verb, which is the one thing a private
    // blocklist must not do — and it would disagree with the front door, whose
    // fall-through answers `404` for exactly the same reason the publish
    // endpoints do when publishing is disabled.
    if (path === `${pathOf(iris.id)}/blocked`) {
      if (
        method !== "GET" ||
        request.headers.get(INTERNAL_HEADERS.publish) !== "1"
      ) {
        return text(404, "Not Found");
      }
      return this.#listBlocked();
    }
    if (path === pathOf(iris.inbox)) {
      if (method === "POST") return this.#handleInbox(request);
      // The inbox is write-only to peers; reads are not part of S2S.
      return text(405, "Method Not Allowed");
    }
    // The instance-level shared inbox (§7.1.3), when served, routes here too:
    // the single actor is the only recipient, so it is handled like the inbox.
    if (config.sharedInbox && path === pathOf(config.sharedInbox)) {
      if (method === "POST") return this.#handleInbox(request);
      return text(405, "Method Not Allowed");
    }
    return text(404, "Not Found");
  }

  // -- inbound ---------------------------------------------------------------

  async #handleInbox(request: Request): Promise<Response> {
    const config = this.#config!;
    let activity: ActivityObject;
    try {
      activity = (await request.json()) as ActivityObject;
    } catch {
      return text(400, "Malformed activity JSON");
    }
    if (!activity || typeof activity !== "object") {
      return text(400, "Malformed activity");
    }

    // The front door verified the HTTP signature and reports the signing actor.
    // Refuse an activity attributed to anyone other than the verified signer:
    // a validly-signed peer must not be able to inject activities on behalf of
    // a different actor (impersonation). `Announce` is unaffected — its top-level
    // `actor` is the announcer (the signer); only the wrapped object differs.
    const signer = request.headers.get(INTERNAL_HEADERS.signedActor);
    const author = actorIri(activity.actor);
    if (signer && author && author !== signer) {
      return text(403, "Activity actor does not match the signing actor");
    }
    // FEP-1b12 group moderation (#376): a banned member's activities are
    // rejected outright, whether or not this particular one is a repeat
    // offense — the ban itself is the enforcement point, not each activity.
    if (config.actorType === "Group" && author && this.#isBanned(author)) {
      return text(403, "Actor is banned from this group");
    }
    // Owner block (#447): everything a blocked actor sends is refused, not just
    // a re-`Follow` — a block that still accepted their replies, likes and
    // mentions into the owner's inbox would only be half a block. Checked
    // before dedup so a blocked actor never consumes a `seen` row either.
    if (author && this.#isBlocked(author)) {
      return text(403, "Actor is blocked");
    }

    const id = activity.id;
    if (typeof id === "string" && id.length > 0) {
      if (this.#alreadySeen(id)) {
        return new Response(null, {
          status: 202,
          headers: { [OUTCOME_HEADER]: ApOutcome.InboxDuplicate },
        });
      }
      this.#recordSeen(id);
    }

    // Reaching here means the activity id was not already seen (the dedup check
    // above returns 202 early for a duplicate). A truthy `firstSeen` is what
    // §7.1.2 requires before considering inbox forwarding.
    const firstSeen = typeof id === "string" && id.length > 0;

    const type = typeof activity.type === "string" ? activity.type : "";
    switch (type) {
      case "Follow":
        await this.#onFollow(activity, config);
        break;
      case "Undo":
        this.#onUndo(activity);
        break;
      case "Join":
        // FEP-1b12: a `Join` targeting the Group actor itself (not one of our
        // owned events) is a membership request — the same auto-`Accept`
        // shape as a `Follow` (#376). A `Join` targeting an event we own
        // stays the existing calendar-RSVP path (#171).
        if (
          config.actorType === "Group" &&
          participationTarget(activity) === config.iris.id
        ) {
          await this.#onFollow(activity, config);
        } else {
          await this.#onJoin(activity, config);
        }
        break;
      case "Leave":
        if (
          config.actorType === "Group" &&
          participationTarget(activity) === config.iris.id
        ) {
          const member = actorIri(activity.actor);
          if (member) {
            this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, member);
          }
        } else {
          this.#onLeave(activity, config);
        }
        break;
      case "Remove":
        await this.#onModerationRemove(activity, config);
        break;
      case "Accept":
        this.#onAccept(activity);
        break;
      case "Reject":
        this.#onReject(activity);
        break;
      case "Delete":
        this.#onDelete(activity);
        break;
      case "Create":
      case "Update":
        // Light content validation (§3 SHOULD): a peer signs as itself, so an
        // embedded object it authors must be attributed to that same actor.
        // Reject a `Create`/`Update` whose object names a *different*
        // `attributedTo` — that is an impersonated object slipped past the
        // top-level actor===signer check. `Announce`/`Like` legitimately wrap
        // another account's object and are exempt (handled below).
        if (!attributionMatches(activity)) {
          return text(403, "Embedded object attributedTo does not match actor");
        }
        await this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        // FEP-1b12 producer side (#376): a member's `Create` is additionally
        // boosted to the whole membership. `Update` is never re-announced —
        // followers who saw the original `Create`'s `Announce` already have
        // the object's id and will fetch the edit through it.
        if (type === "Create") {
          await this.#maybeAnnounceMemberPost(activity, config);
        }
        break;
      case "Like":
      case "Dislike":
        await this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        break;
      case "Announce":
        await this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        // FEP-1b12: a followed Group relays member activities wrapped in its
        // own Announce — unwrap and store the inner activity too (§2.2).
        await this.#maybeUnwrapAnnounce(activity, config);
        break;
      default:
        // Be liberal: an unknown activity is accepted (and ignored) so we do not
        // reject future vocabulary a peer reasonably expects us to tolerate.
        break;
    }

    return new Response(null, {
      status: 202,
      headers: {
        [OUTCOME_HEADER]: ApOutcome.InboxAccepted,
        [OUTCOME_ACTIVITY_HEADER]: type || "Unknown",
      },
    });
  }

  /**
   * Record the follower and, unless the actor manually approves, auto-`Accept`
   * by queuing the follower's inbox for resolution and the signed `Accept` for
   * delivery once it resolves — both run from the alarm (see
   * {@link #processPendingAccepts}), never inline, so a slow or hung remote
   * actor never holds this DO's single input gate open against the peer's POST
   * (or any other request to this actor).
   */
  async #onFollow(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    const follower = actorIri(activity.actor);
    // `participationTarget` (object, falling back to target) rather than a
    // bare `objectId(activity.object)`: a `Follow` only ever sets `object`,
    // but the FEP-1b12 membership `Join` synonym (#376) may name the Group
    // actor via `target` instead — the same dual-field addressing the
    // `#onJoin`/`#onLeave` event-RSVP path already accepts. Using the same
    // resolver here that the dispatch switch used to route here keeps the two
    // checks from disagreeing (a `Join` addressed via `target` alone would
    // otherwise pass routing and then be silently dropped here).
    const target = participationTarget(activity);
    // The Follow must target this actor; a misaddressed Follow is ignored.
    if (!follower || target !== config.iris.id) return;

    // Record the follower first (inbox filled in on the auto-accept path), so a
    // manually-approved actor never triggers an outbound actor fetch here.
    const now = Date.now();
    const alreadyFollowing =
      this.#sql
        .exec(`SELECT 1 FROM followers WHERE actor = ?`, follower)
        .toArray().length > 0;
    // The `Follow`'s own IRI is kept so a later owner `Reject` can name the
    // activity it rejects (#447). Only a real `Follow` contributes one — the
    // FEP-1b12 membership `Join` synonym routes here too, and labelling its id
    // as a `Follow` id would misname it on the wire. A re-`Follow` refreshes a
    // NULL id without disturbing `added_at` or an already-resolved `inbox`.
    const followId =
      activity.type === "Follow" && typeof activity.id === "string"
        ? activity.id
        : null;
    // Owner-admin follow confirmation (#473): auto-accept sets accepted_at
    // immediately; manual approval leaves it NULL until the owner's later
    // Accept action (#routeFollowerControl). A re-Follow must never un-set an
    // already-recorded acceptance, hence the COALESCE in ON CONFLICT below —
    // same "refresh without disturbing settled state" shape as follow_id's.
    const acceptedAt = config.manuallyApprovesFollowers ? null : now;
    this.#sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, follow_id, accepted_at)
         VALUES (?, NULL, ?, ?, ?)
         ON CONFLICT(actor) DO UPDATE
           SET follow_id = COALESCE(excluded.follow_id, followers.follow_id),
               accepted_at = COALESCE(followers.accepted_at, excluded.accepted_at)`,
      follower,
      now,
      followId,
      acceptedAt,
    );
    // A *new* follower is also stored in `inbox` so the Mastodon client API's
    // notifications read surfaces it as a `follow` (see #classifyClientEntry);
    // a re-Follow from an existing follower is not a fresh notification. This
    // also queues the follower's actor-profile fetch, so the notification
    // renders with a real display name/avatar.
    if (!alreadyFollowing) {
      await this.#storeInbox(activity);
    }

    if (config.manuallyApprovesFollowers) return;
    // An unsafe target is rejected synchronously (no network, no queue row) —
    // matches the guard #resolveInbox itself applies before ever fetching.
    if (!isSafeTarget(follower)) return;

    const accept: Record<string, JsonValue> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${config.iris.id}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: config.iris.id,
      object: activityAsObject(activity),
    };
    this.#enqueuePendingAccept("follow", follower, JSON.stringify(accept));
    await this.#armAlarm();
  }

  /** Handle `Undo` of a `Follow` (unfollow); other undos are ignored. */
  #onUndo(activity: ActivityObject): void {
    // Only an embedded `Follow` object is an unfollow. A bare string `object`
    // is an activity IRI this handler does not resolve, so treating it as a
    // `Follow` would let an `Undo Like`/`Undo Announce` carrying a string id
    // silently drop a follower. Require the typed form.
    if (objectType(activity.object) !== "Follow") return;
    const follower = actorIri(activity.actor);
    if (follower)
      this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, follower);
  }

  /**
   * Handle an inbound `Join` — the ActivityPub mirror of an Indie RSVP (#171).
   * Record the participant against the event it targets, but only when that
   * event is one WE own (a local resource); a `Join` aimed at someone else's
   * event is ignored so we are not used to amplify arbitrary RSVPs. Unless the
   * owner manually approves joins, auto-`Accept` by recording `accepted` and
   * enqueuing a signed `Accept` delivered to the participant's inbox — exactly
   * the auto-`Accept`-on-`Follow` shape. The front door already rejected any
   * activity whose `actor` is not the signer, so the participant is the signer.
   */
  async #onJoin(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    const participant = actorIri(activity.actor);
    const event = participationTarget(activity);
    if (!participant || !event || !isLocalResource(event, config.iris)) return;

    // Idempotent re-Join. A *distinct* Join activity (a fresh `id`, so not caught
    // by the activity-`id` dedup) for an already-`accepted` participant must not
    // (a) demote them back to `pending` via the upsert below, nor (b) re-run the
    // outbound inbox resolution + `Accept` delivery on every replay — an
    // amplification vector. Once accepted there is nothing more to do.
    const existing = this.#sql
      .exec<{
        status: string;
      }>(
        `SELECT status FROM attendees WHERE event = ? AND actor = ?`,
        event,
        participant,
      )
      .toArray()[0];
    if (existing?.status === "accepted") return;

    const status = config.manuallyApprovesJoins ? "pending" : "accepted";
    this.#sql.exec(
      `INSERT INTO attendees (event, actor, status, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(event, actor) DO UPDATE SET status = excluded.status`,
      event,
      participant,
      status,
      Date.now(),
    );

    if (config.manuallyApprovesJoins) return;
    if (!isSafeTarget(participant)) return;

    const accept: Record<string, JsonValue> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${config.iris.id}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: config.iris.id,
      object: activityAsObject(activity),
    };
    // Resolve the participant's inbox and deliver from the background alarm,
    // never inline, so the participant's POST is not blocked on our outbound
    // network (see #processPendingAccepts).
    this.#enqueuePendingAccept(
      "join",
      participant,
      JSON.stringify(accept),
      event,
    );
    await this.#armAlarm();
  }

  /**
   * Handle an inbound `Leave` — withdraw an RSVP. Delete the participant's row
   * for the targeted event. Because the front door enforces `actor === signer`,
   * a participant can only withdraw their own RSVP, never someone else's.
   */
  #onLeave(activity: ActivityObject, config: ForwardedConfig): void {
    const participant = actorIri(activity.actor);
    const event = participationTarget(activity);
    if (!participant || !event || !isLocalResource(event, config.iris)) return;
    this.#sql.exec(
      `DELETE FROM attendees WHERE event = ? AND actor = ?`,
      event,
      participant,
    );
  }

  /** Handle a remote `Accept` of our `Follow`: mark that following confirmed. */
  #onAccept(activity: ActivityObject): void {
    const remote = actorIri(activity.actor);
    if (remote) {
      this.#sql.exec(
        `UPDATE following SET state = 'accepted' WHERE actor = ?`,
        remote,
      );
    }
  }

  /**
   * Handle a remote `Reject` of our `Follow`: drop the pending `following` row
   * for the rejecting actor. A `Reject` of a `Follow` we sent leaves the row
   * stuck `pending` forever otherwise, so the request never retries or clears.
   */
  #onReject(activity: ActivityObject): void {
    // Only a `Reject` whose object is the `Follow` we sent concerns us; any
    // other rejected object is for an activity we never tracked here.
    if (objectType(activity.object) !== "Follow") return;
    const remote = actorIri(activity.actor);
    if (remote) {
      this.#sql.exec(`DELETE FROM following WHERE actor = ?`, remote);
    }
  }

  /** Handle `Delete` of an actor: drop it from followers if present. */
  #onDelete(activity: ActivityObject): void {
    const gone = objectId(activity.object);
    if (gone) this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, gone);
  }

  /** Whether an actor is banned from this `Group` (#376). */
  #isBanned(actor: string): boolean {
    return (
      this.#sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM banned WHERE actor = ?`, actor)
        .one().n > 0
    );
  }

  /** Whether the owner has blocked an actor (#447). */
  #isBlocked(actor: string): boolean {
    return (
      this.#sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM blocked WHERE actor = ?`, actor)
        .one().n > 0
    );
  }

  /**
   * `Group` moderation (#376, #473): either bans a member (`target` names our
   * `followers` collection, `object` names the member) or un-announces a
   * member post (`target` names our `outbox`, `object` names the `Announce`
   * id we authored for it). Ignored for a `Person` actor. Shared by the
   * inbound moderator-signed path (`#onModerationRemove`, which checks
   * `config.moderators` before calling this) and the owner-publish path
   * (`#publish`'s `Remove` branch, which skips that check — the owner is
   * implicitly the top moderator of their own actor). `deliver` gates only
   * the un-announce fan-out (`?skipDelivery=1`); the ban branch has no
   * delivery to suppress either way.
   */
  async #applyModerationRemove(
    activity: ActivityObject,
    config: ForwardedConfig,
    deliver: boolean,
  ): Promise<void> {
    if (config.actorType !== "Group") return;
    const object = objectId(activity.object);
    if (!object) return;
    const target = objectId(activity.target);

    if (target === config.iris.followers) {
      this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, object);
      this.#sql.exec(
        `INSERT INTO banned (actor, banned_at) VALUES (?, ?)
           ON CONFLICT(actor) DO UPDATE SET banned_at = excluded.banned_at`,
        object,
        Date.now(),
      );
      return;
    }
    if (target === config.iris.outbox) {
      await this.#removeAnnouncedPost(object, config, deliver);
    }
  }

  /**
   * `Group` moderation (#376): a signed `Remove` from a listed
   * `config.moderators` actor invokes {@link #applyModerationRemove}.
   * Ignored when the (HTTP-signature-verified — see the `signer ===
   * activity.actor` check in {@link #handleInbox}) requester is not a
   * configured moderator. Inbound moderation always delivers — there is no
   * backfill concept for it.
   */
  async #onModerationRemove(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    const moderator = actorIri(activity.actor);
    if (!moderator || !config.moderators.includes(moderator)) return;
    await this.#applyModerationRemove(activity, config, /* deliver */ true);
  }

  /**
   * Un-announce a member post (#376 remove-post): delete the `Announce` we
   * authored for it from our outbox, tombstone the relayed inbox copy so
   * reads stop surfacing it — both always applied — and, unless `deliver` is
   * `false` (`?skipDelivery=1` on an owner-triggered Remove, #473), fan out a
   * self-signed `Undo(Announce)` to the membership so their servers retract
   * the boost too — the same `followers`-inbox fan-out
   * {@link #maybeAnnounceMemberPost} uses.
   */
  async #removeAnnouncedPost(
    announceId: string,
    config: ForwardedConfig,
    deliver: boolean = true,
  ): Promise<void> {
    const row = this.#sql
      .exec<{
        json: string;
      }>(`SELECT json FROM outbox WHERE id = ?`, announceId)
      .toArray()[0];
    if (!row) return;
    let announce: ActivityObject;
    try {
      announce = JSON.parse(row.json) as ActivityObject;
    } catch {
      return;
    }
    if (
      announce.type !== "Announce" ||
      actorIri(announce.actor) !== config.iris.id
    ) {
      return;
    }
    this.#sql.exec(`DELETE FROM outbox WHERE id = ?`, announceId);
    const innerId = objectId(announce.object);
    if (innerId) {
      this.#sql.exec(
        `UPDATE inbox SET removed_at = ? WHERE id = ?`,
        Date.now(),
        innerId,
      );
    }
    if (!deliver) return;
    const undo: Record<string, JsonValue> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${config.iris.id}#undos/${crypto.randomUUID()}`,
      type: "Undo",
      actor: config.iris.id,
      to: [PUBLIC_AUDIENCE],
      cc: [config.iris.followers],
      object: announce as JsonValue,
    };
    const body = JSON.stringify(undo);
    let any = false;
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) {
        this.#enqueueDelivery(row.inbox, body);
        any = true;
      }
    }
    if (any) await this.#armAlarm();
  }

  /**
   * FEP-1b12 producer side (#376): a `Create` from a current member (a row in
   * `followers` — "members = followers" per the design) is wrapped in a
   * server-authored `Announce` and fanned out to the whole membership, the
   * "boost everything a member posts" pattern Lemmy/Mastodon expect from a
   * hosted community. A non-member's `Create` reaching this inbox is stored
   * (by the caller, above) but never announced, so this actor cannot be used
   * to amplify arbitrary content. Ignored for a `Person` actor.
   */
  async #maybeAnnounceMemberPost(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    if (config.actorType !== "Group") return;
    const author = actorIri(activity.actor);
    if (!author) return;
    const member = this.#sql
      .exec<{
        actor: string;
      }>(`SELECT actor FROM followers WHERE actor = ?`, author)
      .toArray()[0];
    if (!member) return;

    const announceId = `${config.iris.outbox}/${crypto.randomUUID()}`;
    const announce = buildAnnounceActivity(
      config.iris,
      announceId,
      new Date().toISOString(),
      activity,
    );
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      announceId,
      JSON.stringify(announce),
      Date.now(),
    );
    const body = JSON.stringify(announce);
    let any = false;
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) {
        this.#enqueueDelivery(row.inbox, body);
        any = true;
      }
    }
    if (any) await this.#armAlarm();
  }

  /**
   * FEP-1b12 group-relay unwrapping (§2.2). When an `Announce` comes from a
   * `Group` we follow (accepted) and wraps an embedded activity of a known
   * kind, store that inner activity attributed to its real author — deduped
   * by the INNER activity id, tagged with the group as `audience` fallback
   * and `relayed_by` provenance, and queued for async origin verification per
   * the configured mode. The outer `Announce` is what the edge signature
   * verified; the inner activity is relayed, unsigned content and is never
   * confusable with directly-signed rows (it always carries `relayed_by`).
   */
  async #maybeUnwrapAnnounce(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    const announcer = actorIri(activity.actor);
    if (!announcer) return;
    const group = this.#sql
      .exec<{
        actor_type: string | null;
      }>(
        `SELECT actor_type FROM following WHERE actor = ? AND state = 'accepted'`,
        announcer,
      )
      .toArray()[0];
    if (!group || group.actor_type !== "Group") return;

    const inner = activity.object;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return;
    const innerActivity = inner as ActivityObject;
    const innerType =
      typeof innerActivity.type === "string" ? innerActivity.type : "";
    if (!RELAYED_ACTIVITY_TYPES.includes(innerType)) return;
    const innerId =
      typeof innerActivity.id === "string" ? innerActivity.id : "";
    if (!innerId) return;
    // Dedup on the INNER id: the same member activity reaches us once per
    // group announce (and possibly directly); only the first copy stores.
    if (this.#alreadySeen(innerId)) return;
    this.#recordSeen(innerId);

    const mode = this.#verifyMode(config);
    const verifyTarget = relayedVerificationTarget(innerActivity);
    const verifiable = mode !== "off" && verifyTarget !== null;
    await this.#storeInbox(innerActivity, {
      relayedBy: announcer,
      verifyState: "pending",
      audienceFallback: announcer,
    });
    if (verifiable) {
      // Content verifies on the next alarm tick; votes wait for the periodic
      // batched sweep unless the mode forces everything immediate.
      const isVote = innerType === "Like" || innerType === "Dislike";
      const dueAt =
        mode === "tiered" && isVote ? Date.now() + VOTE_SWEEP_MS : Date.now();
      this.#sql.exec(
        `INSERT INTO verify_queue (activity_id, target, expect, attempts, next_at)
           VALUES (?, ?, ?, 0, ?)`,
        innerId,
        verifyTarget.target,
        verifyTarget.expect,
        dueAt,
      );
      await this.#armAlarm();
    }
  }

  async #storeInbox(
    activity: ActivityObject,
    relay?: {
      /** The Group actor that relayed this activity (provenance, §2.2). */
      relayedBy: string;
      /** Initial verification state (`pending`; async verification advances it). */
      verifyState: "pending";
      /** Audience recorded when the activity itself names none (the group). */
      audienceFallback: string;
    },
  ): Promise<void> {
    const id =
      typeof activity.id === "string" ? activity.id : crypto.randomUUID();
    // Classification only (object type + community audience) so reads can
    // filter without re-parsing JSON; never validation — unknown shapes store
    // with NULL columns exactly as before.
    const { objectType, audience } = classifyActivity(activity);
    this.#sql.exec(
      `INSERT OR IGNORE INTO inbox
         (id, json, received_at, object_type, audience, relayed_by, verify_state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.now(),
      objectType ?? null,
      audience ?? relay?.audienceFallback ?? null,
      relay?.relayedBy ?? null,
      relay?.verifyState ?? null,
    );
    const actor = actorIri(activity.actor);
    if (actor && isSafeTarget(actor)) this.#queueActorProfile(actor);
    if (relay?.relayedBy && isSafeTarget(relay.relayedBy)) {
      this.#queueActorProfile(relay.relayedBy);
    }
    await this.#armAlarm();
  }

  /**
   * ActivityPub §7.1.2 inbox forwarding ("ghost replies"). When a remote
   * activity (a) is freshly seen, (b) addresses a collection this actor owns —
   * in practice our `followers` collection (directly or via the Public
   * collection) — and (c) references via `object` / `target` / `inReplyTo` /
   * `tag` an object WE own (i.e. an IRI under this actor's resources), we
   * re-deliver the VERBATIM activity to our followers. Without this, a reply to
   * one of our posts never reaches the followers who only saw the original
   * through us ("ghost replies").
   *
   * Conservative by design: we forward only when we actually own the referenced
   * local object, so a peer cannot use us to amplify arbitrary traffic. The
   * §7.1.2 depth limit is satisfied implicitly — we forward only when we are the
   * ORIGIN of the addressed local object (the referenced IRI is ours), never
   * because some upstream server forwarded the activity to us.
   */
  async #maybeForward(
    activity: ActivityObject,
    firstSeen: boolean,
    config: ForwardedConfig,
  ): Promise<void> {
    if (!firstSeen) return;
    if (!this.#addressesFollowers(activity, config.iris)) return;
    if (!this.#referencesLocalObject(activity, config.iris)) return;

    // Re-deliver the activity exactly as received (verbatim) to our followers.
    const body = JSON.stringify(activity);
    let forwarded = false;
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) {
        this.#enqueueDelivery(row.inbox, body);
        forwarded = true;
      }
    }
    if (forwarded) await this.#armAlarm();
  }

  /**
   * Whether the activity's addressing (`to` / `cc` / `audience`) names a
   * collection we own — our `followers` collection, either directly or via the
   * special Public collection that fans out to followers.
   */
  #addressesFollowers(activity: ActivityObject, iris: ActorIris): boolean {
    const recipients = new Set<string>();
    for (const field of ["to", "cc", "audience", "bto", "bcc"] as const) {
      for (const value of audienceValues(activity[field])) {
        recipients.add(value);
      }
    }
    return recipients.has(iris.followers) || recipients.has(PUBLIC_AUDIENCE);
  }

  /**
   * Whether the activity references — via `object`, `target`, `inReplyTo`, or
   * `tag` — an object WE own, i.e. an IRI under this actor's resources. The
   * `inReplyTo` may sit on the wrapped object (e.g. a `Create`'s `Note`), so we
   * inspect both the activity and its embedded object.
   */
  #referencesLocalObject(activity: ActivityObject, iris: ActorIris): boolean {
    const refs: (JsonValue | undefined)[] = [
      activity.object,
      activity.target,
      activity.inReplyTo,
      activity.tag,
    ];
    const inner = activity.object;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const obj = inner as Record<string, JsonValue>;
      // The §7.1.2 reference fields, as they appear on the WRAPPED object (a
      // `Create`'s `Note` carries the `inReplyTo`). The object's own `id` is not
      // a reference to something we own, so it is intentionally excluded.
      refs.push(obj.inReplyTo, obj.target, obj.tag);
    }
    for (const ref of refs) {
      for (const iri of referenceIris(ref)) {
        if (isLocalResource(iri, iris)) return true;
      }
    }
    return false;
  }

  // -- publish (owner C2S seam) ----------------------------------------------

  /**
   * Publish an owner-supplied activity to the outbox and fan it out to every
   * follower's inbox, plus a named `audience` Group's inbox when present (a
   * Lemmy vote: `{"type": "Like"/"Dislike", "object": "<post-iri>",
   * "audience": "<community-iri>"}` — the community is the only way such a
   * vote reaches anyone, since a vote's `object` names content, not an actor,
   * so there is no inbox to derive from it directly). A bare object (e.g. a
   * `Note`) is wrapped in a `Create`. The front door has already authorized
   * this request via the publish token.
   */
  async #publish(request: Request): Promise<Response> {
    const config = this.#config!;
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let input: ActivityObject;
    try {
      input = (await request.json()) as ActivityObject;
    } catch {
      return text(400, "Malformed activity JSON");
    }
    if (input.published !== undefined && !isValidPublished(input.published)) {
      return text(
        400,
        "`published` must be a valid date-time (ISO-8601 recommended)",
      );
    }

    const activity = this.#asOutboxActivity(input, config.iris);
    const id = activity.id as string;
    const skipDelivery =
      request.headers.get(INTERNAL_HEADERS.skipDelivery) === "1";

    // Owner follower control (#447): a `Reject`(Follow), `Block` or
    // `Undo(Block)` names one actor and is a private control activity — it is
    // never written to the outbox (which is served publicly, so an outbox row
    // would publish the owner's moderation decisions) and never fanned out to
    // the follower set. `?skipDelivery=1` keeps its literal meaning here: the
    // local state change still applies, only the federated notification is
    // suppressed — a silent removal. Answers `202` rather than `201` because
    // no addressable resource was created.
    if (isFollowerControlActivity(activity)) {
      const delivered = this.#routeFollowerControl(activity, !skipDelivery);
      if (delivered) await this.#armAlarm();
      return json(202, activity as JsonValue);
    }

    // Owner Group moderation (#473): ban a member / un-announce a post. Not
    // added to isFollowerControlActivity — its delivery model differs (ban
    // has no delivery at all; un-announce's fan-out is a broadcast to the
    // whole membership, not a single target). No config.moderators check
    // here: bearer publishToken auth at the front door is authorization
    // enough, and the owner is implicitly the top moderator of their own
    // actor — this succeeds even when moderators is empty or doesn't list
    // the owner's own actor IRI.
    if (activity.type === "Remove") {
      if (config.actorType !== "Group") {
        return text(400, "`Remove` moderation requires a Group actor");
      }
      await this.#applyModerationRemove(activity, config, !skipDelivery);
      return json(202, activity as JsonValue);
    }

    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.parse(activity.published as string),
    );

    // Quiet-insert mode (#451, backfill): write the historical activity to
    // the outbox and stop — no follower fan-out, no relationship routing (a
    // backfilled Follow shouldn't record a live relationship), no community
    // delivery, no alarm. Set only by an owner request the front door
    // already authorized (`?skipDelivery=1` on this endpoint).
    if (skipDelivery) {
      return json(201, activity as JsonValue, { location: id });
    }

    const body = JSON.stringify(activity);
    // An owner Follow (or Undo-Follow) targets one actor, not our followers:
    // record the relationship and deliver to the target's inbox — resolved
    // from the alarm like every other outbound actor fetch (§2.1).
    if (this.#routeRelationshipActivity(activity, body)) {
      await this.#armAlarm();
      return json(201, activity as JsonValue, { location: id });
    }

    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) this.#enqueueDelivery(row.inbox, body);
    }
    // A vote (Like/Dislike) or any other activity naming a community
    // `audience` (e.g. a Lemmy downvote) additionally reaches that community's
    // inbox — the raw outbox never infers a delivery target from `object`
    // itself (a vote's `object` is a content IRI, not an actor), so this is
    // the only way an outbox-published Like/Dislike reaches anyone but our own
    // followers. Same mechanism {@link #publishPost} uses for community posts.
    if (typeof activity.audience === "string") {
      this.#deliverToAudience(activity.audience, body);
    }
    // Fan-out runs in the background alarm worker, not inline, so a large
    // follower set never slows the owner's publish response.
    await this.#armAlarm();

    return json(201, activity as JsonValue, { location: id });
  }

  /**
   * Route an owner-published relationship activity (`Follow`, `Undo(Follow)`)
   * to its single target: upsert/delete the `following` row (state `pending`
   * until the remote `Accept` arrives) and queue a targeted delivery whose
   * inbox resolution — which also records the target's `actor_type` for
   * FEP-1b12 group detection — runs from the alarm. Returns whether the
   * activity was routed here (in which case follower fan-out is skipped).
   */
  #routeRelationshipActivity(
    activity: Record<string, JsonValue>,
    body: string,
  ): boolean {
    if (activity.type === "Follow") {
      const target = objectId(activity.object as JsonValue);
      if (!target || !isSafeTarget(target)) return true; // routed (dropped)
      this.#sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'pending', ?)
           ON CONFLICT(actor) DO NOTHING`,
        target,
        Date.now(),
      );
      this.#enqueuePendingDelivery(target, body);
      return true;
    }
    if (
      activity.type === "Undo" &&
      objectType(activity.object as JsonValue) === "Follow"
    ) {
      const followed = activity.object as Record<string, JsonValue>;
      const target = objectId(followed.object);
      if (!target) return true;
      this.#sql.exec(`DELETE FROM following WHERE actor = ?`, target);
      if (isSafeTarget(target)) this.#enqueuePendingDelivery(target, body);
      return true;
    }
    return false;
  }

  /**
   * Apply an owner follower-control activity (#447) — `Reject`(Follow),
   * `Block`, `Undo(Block)` — to exactly one actor: mutate the local
   * relationship state and, unless `deliver` is false, queue the activity for
   * that actor's inbox alone through the same targeted queue an owner `Follow`
   * uses. `activity` is normalized in place, so the body the caller echoes back
   * is the body the peer receives. Returns whether a delivery was queued (the
   * caller arms the alarm).
   *
   * Only ever reached for an activity {@link isFollowerControlActivity} claimed,
   * so an unroutable one (no resolvable target) is dropped rather than falling
   * through to follower fan-out — the bug this path exists to prevent.
   */
  #routeFollowerControl(
    activity: Record<string, JsonValue>,
    deliver: boolean,
  ): boolean {
    const iris = this.#config!.iris;
    const now = Date.now();
    // These never reach the outbox, so the outbox-namespaced id
    // `#asOutboxActivity` minted would dereference to a 404 on the peer's
    // side. Re-mint as a fragment of the actor IRI — the same convention the
    // other non-stored activities this package authors use (`#accepts/…`,
    // `#undos/…`).
    activity.id = `${iris.id}#${(activity.type as string).toLowerCase()}s/${crypto.randomUUID()}`;

    if (activity.type === "Accept") {
      const follower = this.#singleFollowTarget(activity);
      if (!follower) return false;
      const row = this.#sql
        .exec<{
          follow_id: string | null;
        }>(`SELECT follow_id FROM followers WHERE actor = ?`, follower)
        .toArray()[0];
      // Unlike Reject's drift-repair looseness: confirming a follow that was
      // never recorded doesn't make sense, so an unknown actor no-ops.
      if (!row) return false;
      // Local state always applies, independent of `deliver`/skipDelivery,
      // which only gates the outbound notification below — same rule every
      // other branch in this method follows.
      this.#sql.exec(
        `UPDATE followers SET accepted_at = COALESCE(accepted_at, ?) WHERE actor = ?`,
        now,
        follower,
      );
      activity.object = {
        ...(row.follow_id ? { id: row.follow_id } : {}),
        type: "Follow",
        actor: follower,
        object: iris.id,
      };
      addressPrivately(activity, follower);
      if (!deliver || !isSafeTarget(follower)) return false;
      this.#enqueuePendingDelivery(follower, JSON.stringify(activity));
      return true;
    }

    if (activity.type === "Reject") {
      const follower = this.#singleFollowTarget(activity);
      if (!follower) return false;
      // The `Follow` being rejected, named by its own IRI when we recorded one
      // (either from the caller or from the row the inbound `Follow` wrote).
      // Mastodon matches a `Reject` on the follow URI when present and falls
      // back to the actor pair, so both shapes sever the relationship.
      const row = this.#sql
        .exec<{
          follow_id: string | null;
        }>(`SELECT follow_id FROM followers WHERE actor = ?`, follower)
        .toArray()[0];
      const embedded =
        objectType(activity.object) === "Follow"
          ? (activity.object as Record<string, JsonValue>)
          : undefined;
      const followId =
        (typeof embedded?.id === "string" ? embedded.id : undefined) ??
        row?.follow_id ??
        undefined;
      this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, follower);
      // Normalize to the canonical `Reject(Follow)` shape whatever the caller
      // sent (an actor-IRI shorthand, a bare `Follow` id, or a full activity):
      // the peer needs `object.actor` = them and `object.object` = us to match
      // the relationship on their side.
      activity.object = {
        ...(followId ? { id: followId } : {}),
        type: "Follow",
        actor: follower,
        object: iris.id,
      };
      addressPrivately(activity, follower);
      if (!deliver || !isSafeTarget(follower)) return false;
      this.#enqueuePendingDelivery(follower, JSON.stringify(activity));
      return true;
    }

    if (activity.type === "Block") {
      const target = objectId(activity.object);
      if (!target) return false;
      // A block severs the relationship in both directions — the peer's server
      // does the same on receipt — so our own `following` row goes too, and no
      // separate `Undo(Follow)` is sent for it. A queued auto-`Accept` for this
      // actor dies with the `followers` row (see `#pendingAcceptStillActive`).
      this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, target);
      this.#sql.exec(`DELETE FROM following WHERE actor = ?`, target);
      this.#sql.exec(
        `INSERT INTO blocked (actor, blocked_at) VALUES (?, ?)
           ON CONFLICT(actor) DO UPDATE SET blocked_at = excluded.blocked_at`,
        target,
        now,
      );
      activity.object = target;
      addressPrivately(activity, target);
      if (!deliver || !isSafeTarget(target)) return false;
      this.#enqueuePendingDelivery(target, JSON.stringify(activity));
      return true;
    }

    // `Undo(Block)` — unblock, and tell the peer so their server restores the
    // ability to interact. The follow relationship is not restored: re-following
    // is the blocked actor's own decision to make again.
    const inner = activity.object as Record<string, JsonValue>;
    const target = objectId(inner.object);
    if (!target) return false;
    this.#sql.exec(`DELETE FROM blocked WHERE actor = ?`, target);
    inner.object = target;
    addressPrivately(activity, target);
    if (!deliver || !isSafeTarget(target)) return false;
    this.#enqueuePendingDelivery(target, JSON.stringify(activity));
    return true;
  }

  /**
   * The follower a single-target `Reject`/`Accept` names. Canonically its
   * `object` is the `Follow` being rejected/accepted (target = that
   * activity's `actor`). As a shorthand the owner may pass a bare IRI, which
   * is read as the stored `Follow`'s id when it matches one we recorded and
   * as the follower's actor IRI otherwise — the two readings a client can
   * reasonably take of "reject/accept this follow".
   *
   * That last fallback deliberately does **not** require a matching
   * `followers` row for `Reject` — a `Reject` is most needed exactly when
   * our state and the peer's disagree — see `#routeFollowerControl`'s
   * `Reject` branch for that looseness; `Accept` layers its own stricter
   * "row must exist" check on top, since confirming a follow that was never
   * recorded doesn't make sense.
   */
  #singleFollowTarget(activity: Record<string, JsonValue>): string | undefined {
    const object = activity.object;
    if (typeof object === "string") {
      const row = this.#sql
        .exec<{
          actor: string;
        }>(`SELECT actor FROM followers WHERE follow_id = ?`, object)
        .toArray()[0];
      return row?.actor ?? object;
    }
    if (objectType(object) !== "Follow") return undefined;
    return actorIri((object as Record<string, JsonValue>).actor);
  }

  /** Queue a delivery to one actor whose inbox resolves from the alarm. */
  #enqueuePendingDelivery(actor: string, body: string): void {
    this.#sql.exec(
      `INSERT INTO pending_accept (kind, actor, event, json, attempts, next_at)
         VALUES ('deliver', ?, NULL, ?, 0, ?)`,
      actor,
      body,
      Date.now(),
    );
  }

  /**
   * Additionally deliver an owner-published activity to a named `audience`
   * Group's inbox, when it resolves to a safe target (FEP-1b12 §2.3): a
   * community post or vote reaches the community this way, which then
   * `Announce`s it to members — we never fan out to members ourselves. Uses
   * the resolved inbox from `following` when we already have it (we do, once
   * the community has been followed and its `Accept` processed); otherwise
   * queues a `pending_accept` delivery whose inbox resolution runs from the
   * alarm, same as every other outbound actor fetch.
   */
  #deliverToAudience(audience: string, body: string): void {
    if (!isSafeTarget(audience)) return;
    const known = this.#sql
      .exec<{
        inbox: string | null;
        shared_inbox: string | null;
      }>(`SELECT inbox, shared_inbox FROM following WHERE actor = ?`, audience)
      .toArray()[0];
    const groupInbox = known?.shared_inbox ?? known?.inbox;
    if (groupInbox) {
      this.#enqueueDelivery(groupInbox, body);
    } else {
      this.#enqueuePendingDelivery(audience, body);
    }
  }

  /**
   * Publish a shaped post (`PostInput`) as a `Create(Note|Article|Page)`:
   * validate, mint server-assigned ids, store to the outbox, and fan out to
   * followers exactly like {@link #publish}. The front door has already
   * authorized the request via the publish token.
   */
  async #publishPost(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(400, "Malformed post JSON");
    }
    const parsed = parsePostInput(body);
    if (!parsed.ok) return text(400, parsed.error);

    const skipDelivery =
      request.headers.get(INTERNAL_HEADERS.skipDelivery) === "1";
    const stored = await this.#storePost(parsed.input, { skipDelivery });
    return json(201, stored.activity as JsonValue, {
      location: stored.activityId,
    });
  }

  /**
   * Build a `Create(Note|Article|Page)` from a parsed {@link PostInput}, store
   * it to the outbox, and fan it out to followers (and any community
   * `audience`) exactly like the AS2 publish path — returning the stored row's
   * outbox coordinates so a caller that needs the Mastodon-shaped snowflake
   * (the `__client/publish` write path) can build it. Shared by `#publishPost`
   * and `#clientPublish`.
   */
  async #storePost(
    input: PostInput,
    opts: { skipDelivery?: boolean } = {},
  ): Promise<{
    activityId: string;
    activity: Record<string, JsonValue>;
    seq: number;
    publishedAt: number;
  }> {
    const config = this.#config!;
    const activityId = `${config.iris.outbox}/${crypto.randomUUID()}`;
    const published = isValidPublished(input.published)
      ? new Date(input.published).toISOString()
      : new Date().toISOString();
    const activity = buildPostActivity(input, config.iris, {
      activityId,
      objectId: `${activityId}/object`,
      published,
    });
    const publishedAt = Date.parse(published);
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      activityId,
      JSON.stringify(activity),
      publishedAt,
    );

    // Quiet-insert mode (#451, backfill): store the row and stop — no
    // follower fan-out, no community delivery, no alarm. `#clientPublish`
    // never sets this, so its live-posting behavior is unchanged.
    if (!opts.skipDelivery) {
      const json_ = JSON.stringify(activity);
      for (const row of this.#sql
        .exec<{
          inbox: string | null;
        }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
        .toArray()) {
        if (row.inbox) this.#enqueueDelivery(row.inbox, json_);
      }
      if (input.audience) {
        this.#deliverToAudience(input.audience, json_);
      }
      await this.#armAlarm();
    }

    const seq = this.#sql
      .exec<{ seq: number }>(`SELECT seq FROM outbox WHERE id = ?`, activityId)
      .one().seq;
    return { activityId, activity, seq, publishedAt };
  }

  /**
   * Internal owner-write path for the Mastodon client API (`POST
   * /api/v1/statuses`, #349 phase-4 writes): publish a status and return it in
   * the `__client/*` row shape (`{seq, receivedAt, activity, source: 1}`) so
   * the adapter renders it with the same `statusEntity` mapper the read path
   * uses. The mastodon-api layer has already authenticated the owner and
   * enforced the `write` scope before setting the publish marker; this route
   * requires both the internal and publish markers, exactly like `/publish`.
   */
  async #clientPublish(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(400, "Malformed post JSON");
    }
    const parsed = parsePostInput(body);
    if (!parsed.ok) return text(400, parsed.error);
    const stored = await this.#storePost(parsed.input);
    return json(200, {
      seq: stored.seq,
      receivedAt: stored.publishedAt,
      activity: stored.activity,
      // Owner-authored, never group-relayed — set explicitly so the row's
      // declared `relayedBy: string | null` holds, matching every other
      // `__client/*` producer (an omitted field would reach `toBackendEntry`
      // as `undefined`).
      relayedBy: null,
      source: 1,
    } as unknown as JsonValue);
  }

  /**
   * Wrap a bare object in a `Create`, assign ids/audience, and timestamp it.
   * A caller-supplied `published` (already validated by `#publish`) is
   * preserved instead of stamped to `now` — the backfill seam (#451).
   */
  #asOutboxActivity(
    input: ActivityObject,
    iris: ActorIris,
  ): Record<string, JsonValue> {
    const isActivity =
      typeof input.type === "string" &&
      [
        "Create",
        "Update",
        "Delete",
        "Announce",
        "Like",
        "Dislike",
        "Follow",
        "Undo",
        // Follower control (#447): these are activities in their own right —
        // wrapping one in a `Create` would publish "the owner created a Block
        // object" instead of performing the block.
        "Block",
        "Reject",
        // Owner admin (#473): confirm a pending follower / Group moderation —
        // same reasoning as Block/Reject above.
        "Accept",
        "Remove",
      ].includes(input.type);
    const published = isValidPublished(input.published)
      ? new Date(input.published).toISOString()
      : new Date().toISOString();
    const activityId = `${iris.outbox}/${crypto.randomUUID()}`;

    if (isActivity) {
      // Per ActivityPub §6 / §3.1 the SERVER assigns the activity `id`; a
      // client-supplied `id` is ignored/overwritten so a peer cannot dictate
      // our IRI space (matching the bare-object wrap path below).
      return {
        "@context": "https://www.w3.org/ns/activitystreams",
        ...(input as Record<string, JsonValue>),
        id: activityId,
        actor: iris.id,
        published,
      };
    }
    // A bare object: wrap it in a Create addressed to the public + followers.
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: activityId,
      type: "Create",
      actor: iris.id,
      published,
      to: [PUBLIC_AUDIENCE],
      cc: [iris.followers],
      object: {
        ...(input as Record<string, JsonValue>),
        id: typeof input.id === "string" ? input.id : `${activityId}/object`,
        attributedTo: iris.id,
        published,
      },
    };
  }

  // -- collections -----------------------------------------------------------

  #serveCollection(
    request: Request,
    collectionId: string,
    kind: "followers" | "following" | "outbox",
  ): Response {
    const config = this.#config!;
    const total = this.#count(kind);
    const url = new URL(request.url);
    const pageParam = url.searchParams.get("page");
    if (pageParam === null) {
      return json(200, buildCollection(collectionId, total, config.pageSize));
    }
    const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
    const items = this.#pageItems(kind, page, config.pageSize);
    return json(
      200,
      buildCollectionPage(collectionId, page, config.pageSize, total, items),
    );
  }

  /**
   * Pending follow requests (#473): followers awaiting the owner's `Accept`.
   * Unpaged flat JSON, like `#listBlocked` — this list is small, and capping
   * it would silently hide requests from the only view of them there is.
   */
  #listFollowRequests(): Response {
    const items = this.#sql
      .exec<{
        actor: string;
        added_at: number;
      }>(
        `SELECT actor, added_at FROM followers WHERE accepted_at IS NULL ORDER BY added_at ASC`,
      )
      .toArray();
    return json(200, { items, total: items.length } as unknown as JsonValue);
  }

  /**
   * The owner's blocklist, newest block first, as flat JSON (`{ items, total }`)
   * rather than an AS2 collection — nothing federates it, and an AS2 envelope
   * would invite exactly that. Unpaged: a personal blocklist is small, and
   * capping it would silently hide blocks from the only view of them there is.
   */
  #listBlocked(): Response {
    const items = this.#sql
      .exec<{
        actor: string;
        blocked_at: number;
      }>(`SELECT actor, blocked_at FROM blocked ORDER BY blocked_at DESC`)
      .toArray()
      .map(
        (row) =>
          ({
            actor: row.actor,
            blockedAt: new Date(row.blocked_at).toISOString(),
          }) as JsonValue,
      );
    return json(200, { items, total: items.length });
  }

  #count(kind: "followers" | "following" | "outbox"): number {
    const table =
      kind === "outbox"
        ? "outbox"
        : kind === "followers"
          ? "followers"
          : "following";
    const where = kind === "following" ? " WHERE state = 'accepted'" : "";
    return this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}${where}`)
      .one().n;
  }

  #pageItems(
    kind: "followers" | "following" | "outbox",
    page: number,
    pageSize: number,
  ): JsonValue[] {
    const offset = (page - 1) * pageSize;
    if (kind === "outbox") {
      return this.#sql
        .exec<{ json: string }>(
          `SELECT json FROM outbox ORDER BY published_at DESC, seq DESC LIMIT ? OFFSET ?`,
          pageSize,
          offset,
        )
        .toArray()
        .map((row) => JSON.parse(row.json) as JsonValue);
    }
    const table = kind === "followers" ? "followers" : "following";
    const where = kind === "following" ? " WHERE state = 'accepted'" : "";
    return this.#sql
      .exec<{ actor: string }>(
        `SELECT actor FROM ${table}${where} ORDER BY added_at DESC LIMIT ? OFFSET ?`,
        pageSize,
        offset,
      )
      .toArray()
      .map((row) => row.actor as JsonValue);
  }

  /**
   * List received inbox activities, newest first, for the owner-only
   * `activitypub_list_inbox` MCP tool. Page-based like {@link #serveCollection},
   * but returns a flat `{ items, total }` listing rather than an AS2
   * `OrderedCollectionPage` envelope — there is no ActivityPub-federated reader
   * of this route, only the composing Worker's own MCP tool contribution.
   */
  #listInbox(request: Request): Response {
    const config = this.#config!;
    const url = new URL(request.url);
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
    );
    const requestedPageSize = Number.parseInt(
      url.searchParams.get("pageSize") ?? "",
      10,
    );
    const pageSize =
      Number.isFinite(requestedPageSize) && requestedPageSize > 0
        ? Math.min(requestedPageSize, config.pageSize)
        : config.pageSize;
    const offset = (page - 1) * pageSize;

    // A moderator-tombstoned row (#376 remove-post) is excluded: the whole
    // point of `removed_at` is that a removed community post stops
    // surfacing through this actor's own reads, not just through the
    // `Undo(Announce)` fanned out to peers.
    const total = this.#sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbox WHERE removed_at IS NULL`,
      )
      .one().n;
    const items = this.#sql
      .exec<{ json: string }>(
        `SELECT json FROM inbox WHERE removed_at IS NULL
           ORDER BY seq DESC LIMIT ? OFFSET ?`,
        pageSize,
        offset,
      )
      .toArray()
      .map((row) => JSON.parse(row.json) as JsonValue);
    return json(200, { items, total, page, pageSize } as JsonValue);
  }

  /**
   * List accepted `following` rows with their typing columns for the
   * internal `__following` route. Flat JSON (not an AS2 collection) — the
   * only reader is the composing Worker's own trusted call.
   */
  #listFollowing(request: Request): Response {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const rows = this.#sql
      .exec<{
        actor: string;
        actor_type: string | null;
        inbox: string | null;
        shared_inbox: string | null;
      }>(
        type
          ? `SELECT actor, actor_type, inbox, shared_inbox FROM following
               WHERE state = 'accepted' AND actor_type = ? ORDER BY added_at DESC`
          : `SELECT actor, actor_type, inbox, shared_inbox FROM following
               WHERE state = 'accepted' ORDER BY added_at DESC`,
        ...(type ? [type] : []),
      )
      .toArray();
    return json(200, {
      items: rows.map((row) => ({
        actor: row.actor,
        actorType: row.actor_type,
        inbox: row.inbox,
        sharedInbox: row.shared_inbox,
      })),
    } as JsonValue);
  }

  /**
   * Classification used by `__client/timeline`/`__client/notifications`
   * (Mastodon client API phase 2, spec/mastodon-client-api.md Decision 3).
   * Read-time, over the parsed activity JSON — `object_type` alone can't
   * distinguish these (it reflects the *embedded object's* type, not the
   * activity's own, and is null for bare-IRI objects like most `Like`s).
   * A `Follow` (or a FEP-1b12 membership `Join`, its synonym on a `Group`
   * actor) reaches `inbox` only when `#onFollow` recorded a *new* follower,
   * so every stored one is a `follow` notification.
   */
  #classifyClientEntry(
    activity: ActivityObject,
  ): "timeline" | "favourite" | "reblog" | "mention" | "follow" | null {
    const type = activity.type;
    if (type === "Create" || type === "Update") {
      // A reply/mention targeting this actor is a notification, not a
      // timeline entry (the timeline is "things I follow posted", the
      // notification is "someone addressed me"). This MUST be checked
      // before the post-shape → "timeline" fallback below: a real
      // reply/mention is almost always a Create of a Note (itself a post
      // shape), so checking post-shape first would make this branch
      // unreachable in the common case.
      const object = activity.object;
      const inReplyTo =
        object && typeof object === "object" && !Array.isArray(object)
          ? (object as Record<string, JsonValue>).inReplyTo
          : undefined;
      if (
        typeof inReplyTo === "string" &&
        inReplyTo.startsWith(this.#config!.iris.id)
      ) {
        return "mention";
      }
      const objType = objectType(activity.object);
      const postShapes = ["Note", "Article", "Page", "Video"];
      if (objType !== undefined && postShapes.includes(objType)) {
        return "timeline";
      }
      return null;
    }
    if (type === "Like") return "favourite";
    if (type === "Announce") return "reblog";
    if (type === "Follow" || type === "Join") return "follow";
    return null;
  }

  /**
   * Shared cursor-paginated reader for `__client/timeline` and
   * `__client/notifications`. Fetches `inbox` rows in `received_at DESC,
   * seq DESC` batches (oldest-first when `min_received_at` selects the
   * opposite direction), classifies each row, keeps the ones matching
   * `kind`, and repeats until either `limit` matches are collected or the
   * table is exhausted — a single bounded `SELECT ... LIMIT ?` cannot fill
   * the page reliably once classification discards non-matching rows.
   */
  #listClientEntries(
    request: Request,
    kind: "timeline" | "notifications",
  ): Response {
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
      ),
      100,
    );
    const maxReceivedAt = url.searchParams.get("max_received_at");
    const sinceReceivedAt = url.searchParams.get("since_received_at");
    const minReceivedAt = url.searchParams.get("min_received_at");
    const tieSeq = url.searchParams.get("tie_seq");
    const tieSource: 0 | 1 = url.searchParams.get("tie_source") === "1" ? 1 : 0;
    // `source=1` restricts a timeline read to the owner's outbox posts only
    // (`GET /api/v1/accounts/:id/statuses` via the `ownStatuses` seam); the
    // inbox scan is skipped entirely.
    const ownerOnly =
      kind === "timeline" && url.searchParams.get("source") === "1";

    const oldestFirst = minReceivedAt !== null;
    /**
     * Convert a combined timeline snowflake bound into a bound for one source
     * table. At the same timestamp every outbox (source 1) id sorts after
     * every inbox (source 0) id, regardless of their independent SQL seqs.
     */
    const boundedWhere = (
      timestamp: "received_at" | "published_at",
      source: 0 | 1,
      initial: string,
    ): { where: string; params: number[] } => {
      let where = initial;
      const params: number[] = [];
      const addBound = (
        value: string | null,
        direction: "before" | "after",
      ): void => {
        if (value === null) return;
        const receivedAt = Number(value);
        if (tieSeq === null) {
          where += ` AND ${timestamp} ${direction === "before" ? "<" : ">"} ?`;
          params.push(receivedAt);
          return;
        }
        const seq = Number(tieSeq);
        if (source === tieSource) {
          where +=
            direction === "before"
              ? ` AND (${timestamp} < ? OR (${timestamp} = ? AND seq < ?))`
              : ` AND (${timestamp} > ? OR (${timestamp} = ? AND seq > ?))`;
          params.push(receivedAt, receivedAt, seq);
        } else if (direction === "before") {
          where += ` AND ${timestamp} ${source < tieSource ? "<=" : "<"} ?`;
          params.push(receivedAt);
        } else {
          where += ` AND ${timestamp} ${source > tieSource ? ">=" : ">"} ?`;
          params.push(receivedAt);
        }
      };
      addBound(maxReceivedAt, "before");
      addBound(sinceReceivedAt, "after");
      addBound(minReceivedAt, "after");
      return { where, params };
    };
    const { where, params } = boundedWhere(
      "received_at",
      0,
      // `removed_at IS NULL`: a moderator-tombstoned post (#376 remove-post)
      // is excluded from the owner's own client-style reads too, not just
      // from the `Undo(Announce)` fanned out to peers.
      "verify_state IS NOT 'failed' AND removed_at IS NULL", // defensive; see cursor-contract note
    );

    const order = oldestFirst ? "ASC" : "DESC";
    const matches: {
      seq: number;
      receivedAt: number;
      activity: JsonValue;
      relayedBy: string | null;
      source?: 0 | 1;
    }[] = [];
    // Classify-and-fill: batches of 4x the page size keep the number of
    // round-trips small for the common case (most rows are timeline-shaped)
    // while still terminating once the table is exhausted.
    const BATCH = Math.max(limit * 4, 40);
    let cursorReceivedAt =
      maxReceivedAt !== null
        ? Number(maxReceivedAt)
        : sinceReceivedAt !== null
          ? Number(sinceReceivedAt)
          : minReceivedAt !== null
            ? Number(minReceivedAt)
            : null;
    let cursorSeq = tieSeq !== null ? Number(tieSeq) : null;
    let exhausted = false;
    // Tracks whether we've issued the first internal batch query yet — the
    // cursor-continuation WHERE clause below must apply to every batch after
    // the first regardless of how many matches have been found so far.
    // Gating it on `matches.length > 0` instead (as a prior version did) lets
    // a zero-match first batch re-issue the exact same query forever.
    let isFirstBatch = true;
    // Bounded for the same reason as the outbox merge below: a notifications
    // page (favourite/reblog/mention) over an inbox dominated by plain
    // Create/Update rows would otherwise scan the whole table.
    let inboxBatches = 0;
    while (
      !ownerOnly &&
      matches.length < limit &&
      !exhausted &&
      inboxBatches < MAX_SCAN_BATCHES
    ) {
      inboxBatches++;
      let batchWhere = where;
      const batchParams = [...params];
      if (cursorReceivedAt !== null && !isFirstBatch) {
        // Subsequent internal batches page from the last row seen so far.
        batchWhere +=
          cursorSeq !== null
            ? oldestFirst
              ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
              : " AND (received_at < ? OR (received_at = ? AND seq < ?))"
            : oldestFirst
              ? " AND received_at > ?"
              : " AND received_at < ?";
        batchParams.push(cursorReceivedAt);
        if (cursorSeq !== null) batchParams.push(cursorReceivedAt, cursorSeq);
      }
      const rows = this.#sql
        .exec<{
          seq: number;
          json: string;
          received_at: number;
          relayed_by: string | null;
        }>(
          `SELECT seq, json, received_at, relayed_by FROM inbox
             WHERE ${batchWhere} ORDER BY received_at ${order}, seq ${order} LIMIT ?`,
          ...batchParams,
          BATCH,
        )
        .toArray();
      isFirstBatch = false;
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const activity = JSON.parse(row.json) as ActivityObject;
        const classification = this.#classifyClientEntry(activity);
        const wanted =
          kind === "timeline"
            ? classification === "timeline"
            : classification === "favourite" ||
              classification === "reblog" ||
              classification === "mention" ||
              classification === "follow";
        if (wanted) {
          matches.push({
            seq: row.seq,
            receivedAt: row.received_at,
            activity: activity as unknown as JsonValue,
            relayedBy: row.relayed_by,
          });
          if (matches.length >= limit) break;
        }
      }
      const last = rows[rows.length - 1];
      cursorReceivedAt = last!.received_at;
      cursorSeq = last!.seq;
      if (rows.length < BATCH) exhausted = true;
    }
    // Owner posts are part of the home timeline too. They receive source bit
    // 1 in their snowflake so they never collide with inbox rows, even when a
    // publish and a delivery share the same millisecond.
    let combinedNewestFirst = false;
    if (kind === "timeline") {
      const initialOutbox = boundedWhere("published_at", 1, "1 = 1");
      const outboxMatches: typeof matches = [];
      let outboxCursorReceivedAt =
        maxReceivedAt !== null
          ? Number(maxReceivedAt)
          : sinceReceivedAt !== null
            ? Number(sinceReceivedAt)
            : minReceivedAt !== null
              ? Number(minReceivedAt)
              : null;
      let outboxCursorSeq = tieSeq !== null ? Number(tieSeq) : null;
      let outboxExhausted = false;
      let isFirstOutboxBatch = true;
      // An owner outbox dominated by non-post activities (Like/Announce/etc.)
      // would otherwise force a near-full-table scan per timeline request;
      // cap the number of batches so a sparse outbox degrades to "found
      // fewer than `limit` owner posts this page" instead of an unbounded scan.
      let outboxBatches = 0;
      while (
        outboxMatches.length < limit &&
        !outboxExhausted &&
        outboxBatches < MAX_SCAN_BATCHES
      ) {
        outboxBatches++;
        let outboxWhere = initialOutbox.where;
        const outboxParams = [...initialOutbox.params];
        if (outboxCursorReceivedAt !== null && !isFirstOutboxBatch) {
          outboxWhere +=
            outboxCursorSeq !== null
              ? oldestFirst
                ? " AND (published_at > ? OR (published_at = ? AND seq > ?))"
                : " AND (published_at < ? OR (published_at = ? AND seq < ?))"
              : oldestFirst
                ? " AND published_at > ?"
                : " AND published_at < ?";
          outboxParams.push(outboxCursorReceivedAt);
          if (outboxCursorSeq !== null) {
            outboxParams.push(outboxCursorReceivedAt, outboxCursorSeq);
          }
        }
        const rows = this.#sql
          .exec<{ seq: number; json: string; published_at: number }>(
            `SELECT seq, json, published_at FROM outbox WHERE ${outboxWhere}
               ORDER BY published_at ${order}, seq ${order} LIMIT ?`,
            ...outboxParams,
            BATCH,
          )
          .toArray();
        isFirstOutboxBatch = false;
        if (rows.length === 0) break;
        for (const row of rows) {
          const activity = JSON.parse(row.json) as ActivityObject;
          const type = activity.type;
          const shape = objectType(activity.object);
          if (
            (type === "Create" || type === "Update") &&
            (shape === "Note" ||
              shape === "Article" ||
              shape === "Page" ||
              shape === "Video")
          ) {
            outboxMatches.push({
              seq: row.seq,
              receivedAt: row.published_at,
              activity: activity as unknown as JsonValue,
              relayedBy: null,
              source: 1,
            });
            if (outboxMatches.length >= limit) break;
          }
        }
        const last = rows[rows.length - 1];
        outboxCursorReceivedAt = last!.published_at;
        outboxCursorSeq = last!.seq;
        if (rows.length < BATCH) outboxExhausted = true;
      }
      if (outboxMatches.length > 0) {
        matches.push(...outboxMatches);
      }
      // Retain the inbox reader's oldest-first contract for min_id requests
      // when there is nothing to merge; the adapter normalizes that ordering.
      // Once owner rows are present, normalize the combined sources here.
      if (outboxMatches.length > 0) {
        matches.sort(
          (a, b) =>
            b.receivedAt - a.receivedAt ||
            (b.source ?? 0) - (a.source ?? 0) ||
            b.seq - a.seq,
        );
        matches.splice(limit);
        combinedNewestFirst = true;
      }
    }

    const items = matches.map((entry) => {
      const resolved = this.#clientResolved(entry.activity);
      return {
        ...entry,
        interactions: this.#clientInteractions(entry.activity),
        // Enrich the resolved reply/boost authors too, so a hydrated reblog's
        // `account` renders from the cached profile (a free DO-local read)
        // rather than the IRI-derived fallback.
        actorProfiles: this.#clientActorProfiles(
          entry.activity,
          entry.relayedBy,
          [resolved.boost?.authorIri, resolved.replyTo?.authorIri],
        ),
        ...resolved,
      };
    });
    return json(200, {
      items,
      combinedNewestFirst,
    } as unknown as JsonValue);
  }

  /**
   * Read-time resolution of an entry's cross-references against rows we hold
   * locally, so the Mastodon client API can thread replies and render boosts.
   * Pure SQL, never a network fetch (resolving a target we do not hold stays
   * a documented gap): a reply whose `inReplyTo` names a locally-stored post
   * carries that post's snowflake coordinates + author (`replyTo`), and a
   * bare-IRI `Announce` of a locally-stored post carries that post's embedded
   * object so the reblog renders with real content (`boost`).
   */
  #clientResolved(activity: JsonValue): {
    replyTo?: {
      receivedAt: number;
      seq: number;
      source: 0 | 1;
      authorIri: string | null;
    };
    boost?: {
      receivedAt: number;
      seq: number;
      source: 0 | 1;
      authorIri: string | null;
      object: JsonValue;
    };
  } {
    const record = activity as Record<string, JsonValue>;
    const type = record.type;
    if (type === "Create" || type === "Update") {
      const object = record.object;
      const inReplyTo =
        object && typeof object === "object" && !Array.isArray(object)
          ? (object as Record<string, JsonValue>).inReplyTo
          : undefined;
      if (typeof inReplyTo === "string") {
        const target = this.#resolveLocalObject(inReplyTo);
        if (target) {
          return {
            replyTo: {
              receivedAt: target.receivedAt,
              seq: target.seq,
              source: target.source,
              authorIri: target.authorIri,
            },
          };
        }
      }
      return {};
    }
    if (type === "Announce") {
      // Only a bare-IRI boost needs hydration — an embedded object already
      // renders. `objectId` returns the IRI for both the bare-string and
      // embedded-with-id shapes, but we only hydrate when the stored `object`
      // is the bare string (an embedded object is self-sufficient).
      const object = record.object;
      if (typeof object === "string") {
        const target = this.#resolveLocalObject(object);
        if (target && target.object !== null) {
          return {
            boost: {
              receivedAt: target.receivedAt,
              seq: target.seq,
              source: target.source,
              authorIri: target.authorIri,
              object: target.object,
            },
          };
        }
      }
      return {};
    }
    return {};
  }

  /**
   * Find a locally-stored post by its AS2 object IRI — the owner's outbox
   * (source 1) first, then the inbox (source 0) — returning the row's
   * snowflake coordinates, its author IRI, and the embedded object JSON.
   * `null` when we hold no copy. Pure SQL; the caller never fetches the IRI.
   */
  #resolveLocalObject(iri: string): {
    receivedAt: number;
    seq: number;
    source: 0 | 1;
    authorIri: string | null;
    object: JsonValue | null;
  } | null {
    if (!iri) return null;
    const parseObject = (json: string): JsonValue | null => {
      try {
        const activity = JSON.parse(json) as Record<string, JsonValue>;
        const object = activity.object;
        return object === undefined ? null : object;
      } catch {
        return null;
      }
    };
    // Owner outbox: the post is the owner's own, so its author is this actor.
    const outboxRow = this.#sql
      .exec<{ seq: number; published_at: number; json: string }>(
        `SELECT seq, published_at, json FROM outbox
           WHERE json_extract(json, '$.object.id') = ? ORDER BY seq LIMIT 1`,
        iri,
      )
      .toArray()[0];
    if (outboxRow) {
      return {
        receivedAt: outboxRow.published_at,
        seq: outboxRow.seq,
        source: 1,
        authorIri: this.#config!.iris.id,
        object: parseObject(outboxRow.json),
      };
    }
    // Inbox: a peer's post we have stored (and not tombstoned / failed).
    const inboxRow = this.#sql
      .exec<{ seq: number; received_at: number; json: string }>(
        `SELECT seq, received_at, json FROM inbox
           WHERE json_extract(json, '$.object.id') = ?
             AND removed_at IS NULL AND verify_state IS NOT 'failed'
           ORDER BY seq LIMIT 1`,
        iri,
      )
      .toArray()[0];
    if (inboxRow) {
      const activity = (() => {
        try {
          return JSON.parse(inboxRow.json) as Record<string, JsonValue>;
        } catch {
          return null;
        }
      })();
      return {
        receivedAt: inboxRow.received_at,
        seq: inboxRow.seq,
        source: 0,
        authorIri: activity ? (actorIri(activity.actor) ?? null) : null,
        object: activity?.object ?? null,
      };
    }
    return null;
  }

  /** Extract interaction counts from the stored inbox without any network I/O. */
  #clientInteractions(activity: JsonValue): {
    replies: number;
    favourites: number;
    reblogs: number;
  } {
    const record = activity as Record<string, JsonValue>;
    const object = record.object;
    const objectId_ = objectId(object);
    const activityId = typeof record.id === "string" ? record.id : null;
    const targets = [objectId_, activityId].filter(
      (value): value is string => !!value,
    );
    if (targets.length === 0) return { replies: 0, favourites: 0, reblogs: 0 };
    const placeholders = targets.map(() => "?").join(", ");
    const row = this.#sql
      .exec<{ replies: number; favourites: number; reblogs: number }>(
        `SELECT
           SUM(CASE WHEN json_extract(json, '$.type') IN ('Create', 'Update')
                         AND json_extract(json, '$.object.inReplyTo') IN (${placeholders}) THEN 1 ELSE 0 END) AS replies,
           SUM(CASE WHEN json_extract(json, '$.type') = 'Like'
                         AND json_extract(json, '$.object') IN (${placeholders}) THEN 1 ELSE 0 END) AS favourites,
           SUM(CASE WHEN json_extract(json, '$.type') = 'Announce'
                         AND json_extract(json, '$.object') IN (${placeholders}) THEN 1 ELSE 0 END) AS reblogs
         FROM inbox WHERE verify_state IS NOT 'failed'`,
        ...targets,
        ...targets,
        ...targets,
      )
      .one();
    return {
      replies: Number(row.replies ?? 0),
      favourites: Number(row.favourites ?? 0),
      reblogs: Number(row.reblogs ?? 0),
    };
  }

  /**
   * Return cached AS2 actor fields for the activity's author, its relay group,
   * and any additionally-resolved actors (a hydrated boost's / reply target's
   * author, so the nested reblog account enriches). Purely cache reads — never
   * a network fetch.
   */
  #clientActorProfiles(
    activity: JsonValue,
    relayedBy: string | null,
    extraActors: ReadonlyArray<string | null | undefined> = [],
  ): Record<string, Record<string, string>> {
    const actors = [
      actorIri((activity as ActivityObject).actor),
      relayedBy,
      ...extraActors,
    ].filter((value): value is string => !!value);
    const profiles: Record<string, Record<string, string>> = {};
    for (const actor of actors) {
      if (profiles[actor]) continue;
      const profile = this.#cachedActorProfile(actor);
      if (profile) profiles[actor] = profile;
    }
    return profiles;
  }

  #cachedActorProfile(actor: string): Record<string, string> | null {
    const row = this.#sql
      .exec<{ json: string }>(
        `SELECT json FROM actor_cache WHERE actor = ?`,
        actor,
      )
      .toArray()[0];
    if (!row) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(row.json) as Record<string, unknown>;
    } catch {
      return null;
    }
    const imageUrl = (value: unknown): string | undefined => {
      if (typeof value === "string") return safeProfileUrl(value);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const url = (value as Record<string, unknown>).url;
        return typeof url === "string" ? safeProfileUrl(url) : undefined;
      }
      return undefined;
    };
    const pick = (key: string): string | undefined =>
      typeof raw[key] === "string" ? (raw[key] as string) : undefined;
    const profile: Record<string, string> = { actor };
    for (const [key, value] of Object.entries({
      preferredUsername: pick("preferredUsername"),
      name: pick("name"),
      summary: pick("summary"),
      url: pick("url") ? safeProfileUrl(pick("url")!) : undefined,
      icon: imageUrl(raw.icon),
      image: imageUrl(raw.image),
    })) {
      if (value) profile[key] = value;
    }
    return profile;
  }

  /**
   * `__client/entry?received_at=<ms>&seq_low=<0-32767>` — single-row lookup
   * for `statuses/:id`. `seq_low` disambiguates the (vanishingly rare) case
   * of two rows sharing a millisecond; the common case matches on
   * `received_at` alone.
   */
  #clientEntry(request: Request): Response {
    const url = new URL(request.url);
    const receivedAt = Number(url.searchParams.get("received_at"));
    const seqLow = url.searchParams.get("seq_low");
    const source = url.searchParams.get("source");
    if (!Number.isFinite(receivedAt)) {
      return json(404, { error: "not found" } as JsonValue);
    }
    const table = source === "1" ? "outbox" : "inbox";
    const timestamp = source === "1" ? "published_at" : "received_at";
    const rows = this.#sql
      .exec<{
        seq: number;
        json: string;
        received_at: number;
        relayed_by: string | null;
      }>(
        source === "1"
          ? `SELECT seq, json, published_at AS received_at, NULL AS relayed_by FROM ${table} WHERE ${timestamp} = ? ORDER BY seq`
          : // `removed_at IS NULL`: a moderator-tombstoned post (#376) 404s here
            // rather than resolving, matching its exclusion from the list reads.
            `SELECT seq, json, received_at, relayed_by FROM ${table} WHERE ${timestamp} = ? AND removed_at IS NULL ORDER BY seq`,
        receivedAt,
      )
      .toArray();
    const row =
      seqLow !== null
        ? (rows.find((r) => r.seq % 32768 === Number(seqLow)) ?? rows[0])
        : rows[0];
    if (!row) return json(404, { error: "not found" } as JsonValue);
    const parsed = JSON.parse(row.json) as JsonValue;
    const resolved = this.#clientResolved(parsed);
    return json(200, {
      seq: row.seq,
      receivedAt: row.received_at,
      activity: parsed,
      relayedBy: row.relayed_by,
      source: source === "1" ? 1 : 0,
      interactions: this.#clientInteractions(parsed),
      actorProfiles: this.#clientActorProfiles(parsed, row.relayed_by, [
        resolved.boost?.authorIri,
        resolved.replyTo?.authorIri,
      ]),
      ...resolved,
    } as unknown as JsonValue);
  }

  /** Cached remote profile lookup for `GET /api/v1/accounts/:id`. */
  #clientActor(request: Request): Response {
    const actor = new URL(request.url).searchParams.get("actor");
    if (!actor) return json(404, { error: "not found" } as JsonValue);
    const profile = this.#cachedActorProfile(actor);
    if (!profile) return json(404, { error: "not found" } as JsonValue);
    return json(200, profile as unknown as JsonValue);
  }

  // -- dedup -----------------------------------------------------------------

  #alreadySeen(id: string): boolean {
    return (
      this.#sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM seen WHERE id = ?`, id)
        .one().n > 0
    );
  }

  #recordSeen(id: string): void {
    const now = Date.now();
    this.#sql.exec(`DELETE FROM seen WHERE seen_at < ?`, now - SEEN_TTL_MS);
    this.#sql.exec(
      `INSERT OR IGNORE INTO seen (id, seen_at) VALUES (?, ?)`,
      id,
      now,
    );
  }

  // -- delivery --------------------------------------------------------------

  #enqueueDelivery(inbox: string, json: string): void {
    this.#sql.exec(
      `INSERT INTO delivery (inbox, json, attempts, next_at) VALUES (?, ?, 0, ?)`,
      inbox,
      json,
      Date.now(),
    );
  }

  /**
   * Alarm-driven delivery has no HTTP response to hang the `x-ap-outcome`
   * header off (see `log.ts`), so these events go straight to `console`
   * instead of through the front-door Logger — visible via `wrangler tail`.
   * Reproduces `@dwk/log`'s `consoleLogger` record shape (`{ level, event,
   * time, ...fields }`) and severity table (`spec/observability.md`): a
   * blocked SSRF attempt or a will-retry failure is `warn`, not `error` —
   * only a permanently-dropped delivery is. Never includes activity bodies,
   * keys, or tokens (redaction policy). The metrics half of the vocabulary
   * has no console-shaped escape hatch, so the matching counter is instead
   * accumulated via {@link #recordMetric} and drained to the front door's
   * injected `Metrics` on the next forwarded request.
   */
  #logDelivery(
    event: ActivityPubLogEvent,
    fields: Record<string, string | number | boolean>,
  ): void {
    const level: "info" | "warn" | "error" =
      event === ActivityPubLogEvent.DeliverySucceeded
        ? "info"
        : fields.dropped === true
          ? "error"
          : "warn";
    const line = JSON.stringify({
      level,
      event,
      time: new Date().toISOString(),
      ...fields,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
    // Counter parity (spec/observability.md: the same `(event, fields)` goes
    // to both seams): the matching count accumulates durably here and reaches
    // the injected `Metrics` when the front door next drains it.
    this.#recordMetric(event, fields);
  }

  /**
   * Accumulate one occurrence of `(event, fields)` for the injected `Metrics`
   * seam the DO cannot call directly. Identical outcomes coalesce into one row
   * (fields serialize with sorted keys); at the table's cardinality cap a new
   * key tallies into the {@link ActivityPubLogEvent.MetricsOverflow} counter
   * instead, so the count survives even when its attribution cannot. A single
   * upsert does both the write and the was-it-a-new-row check: `RETURNING n`
   * yields `1` only for a freshly created row (an existing row increments to
   * ≥ 2), so the cap's row count runs only on that path.
   */
  #recordMetric(
    event: string,
    fields: Record<string, string | number | boolean>,
  ): void {
    const canonical: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(fields).sort()) {
      canonical[key] = fields[key] as string | number | boolean;
    }
    const serialized = JSON.stringify(canonical);
    const n = this.#sql
      .exec<{ n: number }>(
        `INSERT INTO pending_metrics (event, fields, n) VALUES (?, ?, 1)
           ON CONFLICT(event, fields) DO UPDATE SET n = n + 1
           RETURNING n`,
        event,
        serialized,
      )
      .one().n;
    if (n > 1) return; // coalesced into an existing key: row count unchanged
    // The overflow tally itself is exempt from the cap, so a full table can
    // always still count (it adds at most one row beyond the cap).
    if (event === ActivityPubLogEvent.MetricsOverflow) return;
    if (this.#pendingMetricRows() > MAX_PENDING_METRIC_ROWS) {
      this.#sql.exec(
        `DELETE FROM pending_metrics WHERE event = ? AND fields = ?`,
        event,
        serialized,
      );
      this.#recordMetric(ActivityPubLogEvent.MetricsOverflow, {});
    }
  }

  #pendingMetricRows(): number {
    return this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_metrics`)
      .one().n;
  }

  /**
   * Drain accumulated counter deltas for the front door to replay into the
   * injected `Metrics`, bounded per response: at most {@link DRAIN_ROW_LIMIT}
   * distinct deltas (header size) totalling {@link DRAIN_COUNT_BUDGET}
   * occurrences (replay burst). A row larger than the remaining budget is
   * split — the drained part is decremented off, the rest stays queued for the
   * next drain — so a backlog is never dropped, only spread across requests.
   * Selection order (`event, fields`) is deterministic, not FIFO/fair: under
   * sustained churn with rare drains, alphabetically-later keys can be
   * delayed behind ever-reincremented earlier ones — acceptable because these
   * counters are delay-tolerant aggregates, and never lost (the cardinality
   * cap, not ordering, is the only place attribution degrades).
   */
  #drainPendingMetrics(): PendingMetric[] {
    const rows = this.#sql
      .exec<{ event: string; fields: string; n: number }>(
        `SELECT event, fields, n FROM pending_metrics
           ORDER BY event, fields LIMIT ?`,
        DRAIN_ROW_LIMIT,
      )
      .toArray();
    const drained: PendingMetric[] = [];
    let budget = DRAIN_COUNT_BUDGET;
    for (const row of rows) {
      if (budget <= 0) break;
      const take = Math.min(row.n, budget);
      budget -= take;
      let fields: Record<string, string | number | boolean>;
      try {
        fields = JSON.parse(row.fields) as Record<
          string,
          string | number | boolean
        >;
      } catch {
        // An unreadable row can never drain; delete it rather than wedge the
        // queue re-selecting it forever.
        this.#sql.exec(
          `DELETE FROM pending_metrics WHERE event = ? AND fields = ?`,
          row.event,
          row.fields,
        );
        continue;
      }
      drained.push({ event: row.event, fields, n: take });
      if (take === row.n) {
        this.#sql.exec(
          `DELETE FROM pending_metrics WHERE event = ? AND fields = ?`,
          row.event,
          row.fields,
        );
      } else {
        this.#sql.exec(
          `UPDATE pending_metrics SET n = n - ? WHERE event = ? AND fields = ?`,
          take,
          row.event,
          row.fields,
        );
      }
    }
    return drained;
  }

  /**
   * Process every due delivery row once: sign and `POST` it, deleting on
   * success or permanent failure and rescheduling with exponential backoff on a
   * retryable one. Returns how many rows it attempted. Re-arms the alarm for the
   * next due row, if any.
   */
  async #processDeliveries(): Promise<number> {
    const signer = this.#deliverySigner();
    const now = Date.now();
    const due = this.#sql
      .exec<{
        seq: number;
        inbox: string;
        json: string;
        attempts: number;
      }>(
        `SELECT seq, inbox, json, attempts FROM delivery WHERE next_at <= ?
           ORDER BY next_at ASC LIMIT ?`,
        now,
        DELIVERY_BATCH,
      )
      .toArray();

    for (const row of due) {
      if (!signer) {
        // No signing key configured: we can never deliver. Drop the row.
        this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
        continue;
      }
      const targetHost = hostFromUrl(row.inbox) ?? "unknown";
      try {
        const result = await deliverActivity(
          row.inbox,
          row.json,
          signer,
          fetch,
          () => Date.now(),
        );
        if (result.ok) {
          this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
          this.#logDelivery(ActivityPubLogEvent.DeliverySucceeded, {
            targetHost,
            status: result.status,
          });
        } else if (!result.retryable) {
          this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
          this.#logDelivery(ActivityPubLogEvent.DeliveryFailed, {
            targetHost,
            status: result.status,
            attempts: row.attempts + 1,
            dropped: true,
          });
        } else {
          const dropped = this.#rescheduleOrDrop(
            "delivery",
            row.seq,
            row.attempts,
          );
          this.#logDelivery(ActivityPubLogEvent.DeliveryFailed, {
            targetHost,
            status: result.status,
            attempts: row.attempts + 1,
            dropped,
          });
        }
      } catch (error) {
        if (error instanceof DeliveryBlockedError) {
          // Unsafe target — never reachable; drop it.
          this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
          this.#logDelivery(ActivityPubLogEvent.DeliveryBlocked, {
            targetHost,
            reason: error.reason,
          });
        } else {
          const dropped = this.#rescheduleOrDrop(
            "delivery",
            row.seq,
            row.attempts,
          );
          this.#logDelivery(ActivityPubLogEvent.DeliveryFailed, {
            targetHost,
            status: 0,
            attempts: row.attempts + 1,
            dropped,
          });
        }
      }
    }

    await this.#armAlarm();
    return due.length;
  }

  /**
   * Process due origin verifications of group-relayed activities (§2.2): one
   * bounded fetch per row, coalesced by origin within the batch (rows for a
   * host that already failed this pass are rescheduled without a fetch).
   * Outcomes: `verified` advances the inbox row; a definitive refutation
   * (present-when-expected-gone, content gone-when-expected-present, or an
   * id mismatch in a parsed AS2 document) DELETES the inbox row and bumps
   * the persisted failure counter; a vote's 404 is inconclusive (queue row
   * dropped, inbox row stays pending — vote IRIs are often not public); a
   * 2xx with a non-JSON body (CDN error page) and transient errors back off
   * and — at the attempts ceiling — leave the row `pending` (unreachable is
   * not refuted).
   */
  async #processVerifications(): Promise<number> {
    const now = Date.now();
    const due = this.#sql
      .exec<{
        seq: number;
        activity_id: string;
        target: string;
        expect: string;
        attempts: number;
      }>(
        `SELECT seq, activity_id, target, expect, attempts FROM verify_queue
           WHERE next_at <= ? ORDER BY next_at ASC LIMIT ?`,
        now,
        DELIVERY_BATCH,
      )
      .toArray();

    const failedOrigins = new Set<string>();
    for (const row of due) {
      if (!isSafeTarget(row.target)) {
        // Never verifiable — refuse to keep unverifiable relayed content.
        this.#dropRelayedRow(row.seq, row.activity_id);
        continue;
      }
      const origin = new URL(row.target).origin;
      if (failedOrigins.has(origin)) {
        this.#rescheduleOrDrop("verify_queue", row.seq, row.attempts);
        continue;
      }
      let response: Response | null;
      try {
        // Routed through safeFetch (not the bare global `fetch`) so a
        // redirect on this already-validated target is re-validated hop by
        // hop, the same SSRF guard the initial `isSafeTarget` check applies
        // to `row.target` itself (#298).
        ({ response } = await safeFetch(
          fetch,
          row.target,
          { headers: { accept: "application/activity+json" } },
          { allowedSchemes: ["https:"], timeoutMs: OUTBOUND_TIMEOUT_MS },
        ));
      } catch {
        response = null;
      }
      if (response === null) {
        failedOrigins.add(origin);
        this.#rescheduleOrDrop("verify_queue", row.seq, row.attempts);
        continue;
      }
      const gone = response.status === 404 || response.status === 410;
      if (row.expect === "gone") {
        if (gone) {
          this.#markVerified(row.seq, row.activity_id);
        } else if (response.ok) {
          // The relayed Delete claims an object its origin still serves.
          this.#dropRelayedRow(row.seq, row.activity_id);
        } else {
          this.#rescheduleOrDrop("verify_queue", row.seq, row.attempts);
        }
        continue;
      }
      // expect === "present" | "vote"
      if (response.ok) {
        let doc: unknown;
        try {
          doc = await response.json();
        } catch {
          doc = null;
        }
        if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
          // A 2xx whose body is not an AS2 document (a CDN/proxy error page,
          // a challenge interstitial) proves nothing either way — transient,
          // never a refutation that deletes content.
          this.#rescheduleOrDrop("verify_queue", row.seq, row.attempts);
          continue;
        }
        const id = (doc as Record<string, unknown>).id;
        if (id === undefined || id === row.target) {
          this.#markVerified(row.seq, row.activity_id);
        } else {
          this.#dropRelayedRow(row.seq, row.activity_id);
        }
      } else if (gone) {
        if (row.expect === "vote") {
          // Platforms routinely 404 vote IRIs they never serve publicly —
          // inconclusive: stop verifying, keep the (provisional) row pending.
          this.#sql.exec(`DELETE FROM verify_queue WHERE seq = ?`, row.seq);
        } else {
          this.#dropRelayedRow(row.seq, row.activity_id);
        }
      } else {
        this.#rescheduleOrDrop("verify_queue", row.seq, row.attempts);
      }
    }

    await this.#armAlarm();
    return due.length;
  }

  /** Queue one actor-document hydration without duplicating work. */
  #queueActorProfile(actor: string): void {
    this.#sql.exec(
      `INSERT INTO actor_profile_queue (actor, attempts, next_at) VALUES (?, 0, ?)
         ON CONFLICT(actor) DO NOTHING`,
      actor,
      Date.now() + ACTOR_PROFILE_DEBOUNCE_MS,
    );
  }

  /**
   * Refresh a bounded batch of remote actor documents from the alarm. The
   * cache is deliberately best-effort: a missing or stale profile never hides
   * an inbox activity, it only falls back to the deterministic synthesized
   * account that phase 2 already returned.
   */
  async #processActorProfiles(): Promise<number> {
    const due = this.#sql
      .exec<{ actor: string; attempts: number }>(
        `SELECT actor, attempts FROM actor_profile_queue WHERE next_at <= ?
           ORDER BY next_at ASC LIMIT ?`,
        Date.now(),
        DELIVERY_BATCH,
      )
      .toArray();
    for (const row of due) {
      if (!isSafeTarget(row.actor)) {
        this.#sql.exec(
          `DELETE FROM actor_profile_queue WHERE actor = ?`,
          row.actor,
        );
        continue;
      }
      let response: Response | null = null;
      try {
        ({ response } = await safeFetch(
          fetch,
          row.actor,
          { headers: { accept: "application/activity+json" } },
          { allowedSchemes: ["https:"], timeoutMs: OUTBOUND_TIMEOUT_MS },
        ));
      } catch {
        // Retried below using the same bounded backoff policy as deliveries.
      }
      if (!response?.ok) {
        const next = row.attempts + 1;
        if (next >= this.#deliveryPolicy("deliveryMaxAttempts", 8)) {
          this.#sql.exec(
            `DELETE FROM actor_profile_queue WHERE actor = ?`,
            row.actor,
          );
        } else {
          const delay =
            this.#deliveryPolicy("deliveryBaseDelayMs", 60_000) *
            2 ** row.attempts;
          this.#sql.exec(
            `UPDATE actor_profile_queue SET attempts = ?, next_at = ? WHERE actor = ?`,
            next,
            Date.now() + delay,
            row.actor,
          );
        }
        continue;
      }
      const body = await readBodyCapped(response, ACTOR_PROFILE_MAX_BODY_BYTES);
      let doc: unknown = null;
      if (body !== null) {
        try {
          doc = JSON.parse(body) as unknown;
        } catch {
          // Invalid actor JSON is a terminal profile-cache miss, not a retry.
        }
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        this.#sql.exec(
          `DELETE FROM actor_profile_queue WHERE actor = ?`,
          row.actor,
        );
        continue;
      }
      this.#sql.exec(
        `INSERT INTO actor_cache (actor, json, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(actor) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
        row.actor,
        JSON.stringify(doc),
        Date.now(),
      );
      this.#sql.exec(
        `DELETE FROM actor_profile_queue WHERE actor = ?`,
        row.actor,
      );
    }
    await this.#armAlarm();
    return due.length;
  }

  #markVerified(seq: number, activityId: string): void {
    this.#sql.exec(
      `UPDATE inbox SET verify_state = 'verified' WHERE id = ?`,
      activityId,
    );
    this.#sql.exec(`DELETE FROM verify_queue WHERE seq = ?`, seq);
  }

  /** A refuted relayed activity: remove it and count the failure. */
  #dropRelayedRow(seq: number, activityId: string): void {
    this.#sql.exec(`DELETE FROM inbox WHERE id = ?`, activityId);
    this.#sql.exec(`DELETE FROM verify_queue WHERE seq = ?`, seq);
    const failed = Number(this.#kvGet("verifyFailed") ?? "0");
    this.#kvPut("verifyFailed", String(failed + 1));
  }

  /** Reschedules with backoff, or deletes at the attempts ceiling. Returns whether it dropped. */
  #rescheduleOrDrop(
    table: "delivery" | "pending_accept" | "verify_queue",
    seq: number,
    attempts: number,
  ): boolean {
    const next = attempts + 1;
    const max = this.#deliveryPolicy("deliveryMaxAttempts", 8);
    if (next >= max) {
      this.#sql.exec(`DELETE FROM ${table} WHERE seq = ?`, seq);
      return true;
    }
    const base = this.#deliveryPolicy("deliveryBaseDelayMs", 60_000);
    const delay = base * 2 ** attempts;
    this.#sql.exec(
      `UPDATE ${table} SET attempts = ?, next_at = ? WHERE seq = ?`,
      next,
      Date.now() + delay,
      seq,
    );
    return false;
  }

  #enqueuePendingAccept(
    kind: "follow" | "join",
    actor: string,
    json: string,
    event: string | null = null,
  ) {
    this.#sql.exec(
      `INSERT INTO pending_accept (kind, actor, event, json, attempts, next_at) VALUES (?, ?, ?, ?, 0, ?)`,
      kind,
      actor,
      event,
      json,
      Date.now(),
    );
  }

  /**
   * Whether a pending `Accept` is still worth delivering: the follower hasn't
   * `Undo`ne their `Follow`, or the participant hasn't `Leave`-withdrawn (or
   * been demoted off `accepted`) since the auto-Accept was queued. Checked
   * before resolving the inbox so an actor who retracted in the interim costs
   * neither the outbound lookup nor a stray `Accept` for something they no
   * longer requested.
   */
  #pendingAcceptStillActive(row: {
    kind: string;
    actor: string;
    event: string | null;
  }): boolean {
    // A targeted delivery ('deliver') is always worth attempting; a profile
    // resolution ('profile') only while the following row still exists.
    if (row.kind === "deliver") return true;
    if (row.kind === "profile") {
      return (
        this.#sql
          .exec<{
            n: number;
          }>(`SELECT COUNT(*) AS n FROM following WHERE actor = ?`, row.actor)
          .one().n > 0
      );
    }
    if (row.kind === "follow") {
      return (
        this.#sql
          .exec<{
            n: number;
          }>(`SELECT COUNT(*) AS n FROM followers WHERE actor = ?`, row.actor)
          .one().n > 0
      );
    }
    if (!row.event) return false;
    return (
      this.#sql
        .exec<{
          n: number;
        }>(
          `SELECT COUNT(*) AS n FROM attendees WHERE event = ? AND actor = ? AND status = 'accepted'`,
          row.event,
          row.actor,
        )
        .one().n > 0
    );
  }

  /**
   * Resolve every due auto-`Accept`'s target inbox once: on success, record the
   * resolved inbox for a `follow` (so future fan-out reaches this follower
   * without re-resolving) and hand the `Accept` to the ordinary delivery queue;
   * on failure, reschedule with the same backoff {@link #processDeliveries}
   * uses, or drop after the max-attempts ceiling. This is what keeps the
   * outbound actor-document fetch off the inbound POST's critical path — see
   * `#onFollow` / `#onJoin`.
   */
  async #processPendingAccepts(): Promise<number> {
    // Lazily backfill follow-target typing first (§2.1): following rows that
    // predate the typing columns get a queued profile resolution, so existing
    // Group follows start qualifying for announce unwrapping — no re-follow.
    this.#backfillFollowingTypes();

    const now = Date.now();
    const due = this.#sql
      .exec<{
        seq: number;
        kind: string;
        actor: string;
        event: string | null;
        json: string;
        attempts: number;
      }>(
        `SELECT seq, kind, actor, event, json, attempts FROM pending_accept WHERE next_at <= ?
           ORDER BY next_at ASC LIMIT ?`,
        now,
        DELIVERY_BATCH,
      )
      .toArray();

    for (const row of due) {
      if (!this.#pendingAcceptStillActive(row)) {
        this.#sql.exec(`DELETE FROM pending_accept WHERE seq = ?`, row.seq);
        continue;
      }
      const resolved = await this.#resolveInbox(row.actor);
      if (!resolved) {
        // A profile resolution that is about to hit the attempts ceiling
        // marks the following row 'Unknown' so the backfill never re-queues
        // it (and it never qualifies as a Group).
        if (
          row.attempts + 1 >=
          this.#deliveryPolicy("deliveryMaxAttempts", 8)
        ) {
          this.#sql.exec(
            `UPDATE following SET actor_type = 'Unknown'
               WHERE actor = ? AND actor_type IS NULL`,
            row.actor,
          );
        }
        const dropped = this.#rescheduleOrDrop(
          "pending_accept",
          row.seq,
          row.attempts,
        );
        this.#logDelivery(ActivityPubLogEvent.DeliveryFailed, {
          targetHost: hostFromUrl(row.actor) ?? "unknown",
          status: 0,
          attempts: row.attempts + 1,
          dropped,
          stage: "resolve",
        });
        continue;
      }
      if (row.kind === "follow") {
        // Keep the shared inbox separately so future fan-out can batch
        // deliveries per instance (spec/fediverse-interop.md storage deltas).
        this.#sql.exec(
          `UPDATE followers SET inbox = ?, shared_inbox = ? WHERE actor = ?`,
          resolved.inbox,
          resolved.sharedInbox,
          row.actor,
        );
      }
      // Any resolution doubles as follow-target typing (§2.1) when we follow
      // the resolved actor: record its AS2 type + inboxes on the row.
      this.#sql.exec(
        `UPDATE following SET actor_type = ?, inbox = ?, shared_inbox = ?
           WHERE actor = ?`,
        resolved.actorType ?? "Unknown",
        resolved.inbox,
        resolved.sharedInbox,
        row.actor,
      );
      if (row.kind !== "profile") {
        this.#enqueueDelivery(resolved.inbox, row.json);
      }
      this.#sql.exec(`DELETE FROM pending_accept WHERE seq = ?`, row.seq);
    }

    return due.length;
  }

  /**
   * Queue a profile resolution for following rows whose `actor_type` is still
   * NULL (pre-#275 rows, or rows whose Follow predates typing) — at most a
   * small batch per pass, and never while a resolution for that actor is
   * already queued. Terminal failures mark the row 'Unknown' (see above), so
   * this converges instead of churning.
   */
  #backfillFollowingTypes(): void {
    const rows = this.#sql
      .exec<{ actor: string }>(
        `SELECT actor FROM following
           WHERE actor_type IS NULL
             AND actor NOT IN (
               SELECT actor FROM pending_accept WHERE kind IN ('profile', 'deliver')
             )
           LIMIT 5`,
      )
      .toArray();
    for (const row of rows) {
      this.#sql.exec(
        `INSERT INTO pending_accept (kind, actor, event, json, attempts, next_at)
           VALUES ('profile', ?, NULL, '{}', 0, ?)`,
        row.actor,
        Date.now(),
      );
    }
  }

  /** Schedule the alarm for the earliest pending delivery or accept, if any. */
  async #armAlarm(): Promise<void> {
    const next = this.#sql
      .exec<{
        next_at: number | null;
      }>(
        `SELECT MIN(next_at) AS next_at FROM (
           SELECT next_at FROM delivery
           UNION ALL
           SELECT next_at FROM pending_accept
           UNION ALL
           SELECT next_at FROM verify_queue
           UNION ALL
           SELECT next_at FROM actor_profile_queue
         )`,
      )
      .one().next_at;
    if (next === null) return;
    await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    // Resolve any due auto-Accepts first so a newly-resolved inbox is attempted
    // in this same pass, not deferred to the next wake.
    await this.#processPendingAccepts();
    await this.#processDeliveries();
    await this.#processVerifications();
    await this.#processActorProfiles();
  }

  // -- helpers ---------------------------------------------------------------

  #stats(): Response {
    const localPosts = this.#count("outbox");
    return json(200, {
      users: 1,
      localPosts,
      followers: this.#count("followers"),
      following: this.#count("following"),
      statuses: localPosts,
    } as JsonValue);
  }

  /**
   * Resolve a remote actor's delivery inbox (sharedInbox preferred, unchanged
   * behavior) plus the raw `endpoints.sharedInbox` so callers can persist it
   * for per-instance fan-out batching. `null` when the actor is unreachable or
   * carries no usable inbox.
   */
  async #resolveInbox(actor: string): Promise<{
    inbox: string;
    sharedInbox: string | null;
    actorType: string | null;
  } | null> {
    try {
      assertPublicHttpsTarget(actor);
    } catch {
      return null;
    }
    let response: Response;
    try {
      // Routed through safeFetch (not the bare global `fetch`) so a redirect
      // off this already-validated actor IRI is re-validated hop by hop
      // rather than trusting the initial `assertPublicHttpsTarget` check
      // alone (#298).
      ({ response } = await safeFetch(
        fetch,
        actor,
        { headers: { accept: "application/activity+json" } },
        { allowedSchemes: ["https:"], timeoutMs: OUTBOUND_TIMEOUT_MS },
      ));
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let doc: unknown;
    try {
      doc = await response.json();
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object") return null;
    const record = doc as Record<string, unknown>;
    let sharedInbox: string | null = null;
    const endpoints = record.endpoints;
    if (endpoints && typeof endpoints === "object") {
      const shared = (endpoints as Record<string, unknown>).sharedInbox;
      if (typeof shared === "string") sharedInbox = shared;
    }
    const personal = typeof record.inbox === "string" ? record.inbox : null;
    const inbox = sharedInbox ?? personal;
    const actorType = typeof record.type === "string" ? record.type : null;
    return inbox === null ? null : { inbox, sharedInbox, actorType };
  }

  #deliverySigner(): { keyId: string; privateKeyPem: string } | null {
    const keyId = this.#kvGet("keyId");
    const privateKeyPem = this.#kvGet("privateKeyPem");
    if (keyId && privateKeyPem) return { keyId, privateKeyPem };
    return null;
  }

  #persistDeliveryConfig(config: ForwardedConfig): void {
    if (config.privateKeyPem) {
      this.#kvPut("privateKeyPem", config.privateKeyPem);
      this.#kvPut("keyId", config.keyId);
    }
    // Persist the retry policy too: an alarm can wake on a cold isolate where
    // `#config` is null, and the backoff must still honor the configured policy
    // rather than silently fall back to defaults.
    this.#kvPut("deliveryMaxAttempts", String(config.deliveryMaxAttempts));
    this.#kvPut("deliveryBaseDelayMs", String(config.deliveryBaseDelayMs));
    // Same for the relay-verification mode: the verify sweep runs from the
    // alarm and must honor the configured mode on a cold isolate.
    if (config.verifyRelayedObjects) {
      this.#kvPut("verifyRelayedObjects", config.verifyRelayedObjects);
    }
  }

  /** The relay-verification mode: live config first, then the persisted copy. */
  #verifyMode(config?: ForwardedConfig): "tiered" | "immediate" | "off" {
    const live =
      config?.verifyRelayedObjects ?? this.#config?.verifyRelayedObjects;
    if (live === "tiered" || live === "immediate" || live === "off")
      return live;
    const stored = this.#kvGet("verifyRelayedObjects");
    if (stored === "tiered" || stored === "immediate" || stored === "off") {
      return stored;
    }
    return "tiered";
  }

  /** A numeric delivery-policy value: live config first, then the persisted copy. */
  #deliveryPolicy(
    key: "deliveryMaxAttempts" | "deliveryBaseDelayMs",
    fallback: number,
  ): number {
    const live = this.#config?.[key];
    if (typeof live === "number") return live;
    const stored = this.#kvGet(key);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  #kvGet(key: string): string | null {
    const row = this.#sql
      .exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, key)
      .toArray();
    return row.length > 0 ? (row[0] as { v: string }).v : null;
  }

  #kvPut(key: string, value: string): void {
    this.#sql.exec(
      `INSERT INTO kv (k, v) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    );
  }

  #readConfig(request: Request): ForwardedConfig | null {
    const raw = request.headers.get(INTERNAL_HEADERS.config);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ForwardedConfig;
    } catch {
      return null;
    }
  }
}

/** The path portion (with query) of an IRI, for routing comparisons. */
function pathOf(iri: string): string {
  return new URL(iri).pathname;
}

/** Only surface safe absolute HTTPS asset/profile URLs from remote actor docs. */
function safeProfileUrl(value: string): string | undefined {
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a `Create`/`Update`'s embedded object(s) are attributed to the
 * activity's own actor. Liberal: an absent object, a string-IRI object, or an
 * object with no `attributedTo` all pass (nothing to contradict). Both `object`
 * and `attributedTo` may be arrays in ActivityStreams, so *every* embedded
 * object and *every* named attribution is checked — a present `attributedTo`
 * that names a different actor fails even when wrapped in an array (closing an
 * impersonation bypass).
 */
function attributionMatches(activity: ActivityObject): boolean {
  const author = actorIri(activity.actor);
  if (!author) return true;
  for (const object of asArray(activity.object)) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      continue;
    }
    const attributedTo = (object as Record<string, JsonValue>).attributedTo;
    for (const attribution of asArray(attributedTo)) {
      const iri = actorIri(attribution);
      if (iri !== undefined && iri !== author) return false;
    }
  }
  return true;
}

/** Wrap a value as an array: empty for nullish, itself when already an array. */
function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Flatten an addressing field (`to`/`cc`/…) to the set of IRI strings it names. */
function audienceValues(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Flatten a reference field (`object`/`target`/`inReplyTo`/`tag`) to the IRI
 * strings it points at, whether it is a string, an embedded object (its `id`),
 * or an array of either.
 */
function referenceIris(value: JsonValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => referenceIris(v));
  }
  const id = objectId(value);
  return id ? [id] : [];
}

/**
 * Whether an IRI names a resource this actor owns: same origin as the actor IRI
 * and a path under the actor's path prefix. Conservative on purpose — only an
 * IRI clearly within our resource space counts as ours.
 */
function isLocalResource(iri: string, iris: ActorIris): boolean {
  let url: URL;
  let actor: URL;
  try {
    url = new URL(iri);
    actor = new URL(iris.id);
  } catch {
    return false;
  }
  if (url.origin !== actor.origin) return false;
  // The actor IRI itself, or any path beneath it (e.g. `<actor>/outbox/<uuid>`,
  // `<actor>/statuses/1`) is ours. Normalize the trailing slash so a
  // root-hosted actor (pathname `/`) doesn't produce a `//` prefix that never
  // matches — every same-origin resource is then correctly under it.
  const prefix = actor.pathname.endsWith("/")
    ? actor.pathname
    : `${actor.pathname}/`;
  return url.pathname === actor.pathname || url.pathname.startsWith(prefix);
}

/**
 * What origin fetch verifies a relayed activity (§2.2), or `null` when the
 * shape gives us nothing verifiable. `Create`/`Update` verify the created
 * object at its id (expect present); `Delete` verifies the object is GONE
 * (404/410); votes verify the vote activity itself at the author's origin.
 */
function relayedVerificationTarget(
  inner: ActivityObject,
): { target: string; expect: "present" | "gone" | "vote" } | null {
  const type = typeof inner.type === "string" ? inner.type : "";
  if (type === "Create" || type === "Update") {
    const target = objectId(inner.object) ?? inner.id;
    return typeof target === "string" ? { target, expect: "present" } : null;
  }
  if (type === "Delete") {
    const target = objectId(inner.object);
    return typeof target === "string" ? { target, expect: "gone" } : null;
  }
  if (type === "Like" || type === "Dislike") {
    // Votes verify at the activity id, but many platforms never serve vote
    // IRIs publicly — so a vote gets its own expectation kind whose 404 is
    // INCONCLUSIVE (row stays pending) rather than a refutation.
    return typeof inner.id === "string"
      ? { target: inner.id, expect: "vote" }
      : null;
  }
  return null;
}

/**
 * Reduce an inbound activity to the object form embedded in an `Accept`: the
 * full activity minus our internal/context noise, so the follower can match it
 * to the `Follow` they sent.
 */
function activityAsObject(activity: ActivityObject): JsonValue {
  const copy: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(activity)) {
    if (value !== undefined) copy[key] = value;
  }
  return copy;
}
