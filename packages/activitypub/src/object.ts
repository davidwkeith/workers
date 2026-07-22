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
import { safeFetch } from "@dwk/safe-fetch";

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
  buildPostActivity,
  classifyActivity,
  parsePostInput,
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
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS followers (
         actor TEXT PRIMARY KEY, inbox TEXT, added_at INTEGER NOT NULL,
         shared_inbox TEXT)`,
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
    this.#ensureColumn("followers", "shared_inbox", "TEXT");
    this.#ensureColumn("following", "actor_type", "TEXT");
    this.#ensureColumn("following", "inbox", "TEXT");
    this.#ensureColumn("following", "shared_inbox", "TEXT");
  }

  /**
   * Add a nullable column if this object predates it (additive migration).
   * Checks `PRAGMA table_info` first (matching `@dwk/store`'s pattern) rather
   * than attempting the `ALTER TABLE` and pattern-matching the error string
   * for "duplicate column" — a substring match would silently swallow an
   * unrelated SQLite error (e.g. a disk-full write failure) that happens to
   * mention "duplicate column" in its own message, or miss a legitimate
   * duplicate-column error phrased differently by a future SQLite version.
   */
  #ensureColumn(table: string, column: string, type: string): void {
    const columns = this.#sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (columns.some((c) => c.name === column)) return;
    this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
      return json(200, { processed: due + resolved + verified });
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
        await this.#onJoin(activity, config);
        break;
      case "Leave":
        this.#onLeave(activity, config);
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
        this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        break;
      case "Like":
      case "Dislike":
        this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        break;
      case "Announce":
        this.#storeInbox(activity);
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
    const target = objectId(activity.object);
    // The Follow must target this actor; a misaddressed Follow is ignored.
    if (!follower || target !== config.iris.id) return;

    // Record the follower first (inbox filled in on the auto-accept path), so a
    // manually-approved actor never triggers an outbound actor fetch here.
    const now = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO followers (actor, inbox, added_at) VALUES (?, NULL, ?)`,
      follower,
      now,
    );

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
    // is an activity IRI we cannot classify (we do not store inbound `Follow`s),
    // so treating it as a `Follow` would let an `Undo Like`/`Undo Announce`
    // carrying a string id silently drop a follower. Require the typed form.
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
    this.#storeInbox(innerActivity, {
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

  #storeInbox(
    activity: ActivityObject,
    relay?: {
      /** The Group actor that relayed this activity (provenance, §2.2). */
      relayedBy: string;
      /** Initial verification state (`pending`; async verification advances it). */
      verifyState: "pending";
      /** Audience recorded when the activity itself names none (the group). */
      audienceFallback: string;
    },
  ): void {
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

    const activity = this.#asOutboxActivity(input, config.iris);
    const id = activity.id as string;
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.now(),
    );

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
    const config = this.#config!;
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

    const activityId = `${config.iris.outbox}/${crypto.randomUUID()}`;
    const activity = buildPostActivity(parsed.input, config.iris, {
      activityId,
      objectId: `${activityId}/object`,
      published: new Date().toISOString(),
    });
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      activityId,
      JSON.stringify(activity),
      Date.now(),
    );

    const json_ = JSON.stringify(activity);
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) this.#enqueueDelivery(row.inbox, json_);
    }
    if (parsed.input.audience) {
      this.#deliverToAudience(parsed.input.audience, json_);
    }
    await this.#armAlarm();

    return json(201, activity as JsonValue, { location: activityId });
  }

  /** Wrap a bare object in a `Create`, assign ids/audience, and timestamp it. */
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
      ].includes(input.type);
    const published = new Date().toISOString();
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
          `SELECT json FROM outbox ORDER BY seq DESC LIMIT ? OFFSET ?`,
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

    const total = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)
      .one().n;
    const items = this.#sql
      .exec<{ json: string }>(
        `SELECT json FROM inbox ORDER BY seq DESC LIMIT ? OFFSET ?`,
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
   * `Follow` is deliberately absent: inbound Follows never reach `inbox`
   * (see docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md).
   */
  #classifyClientEntry(
    activity: ActivityObject,
  ): "timeline" | "favourite" | "reblog" | "mention" | null {
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

    const oldestFirst = minReceivedAt !== null;
    let where = "verify_state IS NOT 'failed'"; // defensive; see cursor-contract note
    const params: (string | number)[] = [];
    if (maxReceivedAt !== null) {
      where +=
        tieSeq !== null
          ? " AND (received_at < ? OR (received_at = ? AND seq < ?))"
          : " AND received_at < ?";
      params.push(Number(maxReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(maxReceivedAt), Number(tieSeq));
      }
    }
    if (sinceReceivedAt !== null) {
      where +=
        tieSeq !== null
          ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
          : " AND received_at > ?";
      params.push(Number(sinceReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(sinceReceivedAt), Number(tieSeq));
      }
    }
    if (minReceivedAt !== null) {
      where +=
        tieSeq !== null
          ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
          : " AND received_at > ?";
      params.push(Number(minReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(minReceivedAt), Number(tieSeq));
      }
    }

    const order = oldestFirst ? "ASC" : "DESC";
    const matches: {
      seq: number;
      receivedAt: number;
      activity: JsonValue;
      relayedBy: string | null;
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
    while (matches.length < limit && !exhausted) {
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
              classification === "mention";
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

    return json(200, { items: matches } as unknown as JsonValue);
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
    if (!Number.isFinite(receivedAt)) {
      return json(404, { error: "not found" } as JsonValue);
    }
    const rows = this.#sql
      .exec<{
        seq: number;
        json: string;
        received_at: number;
        relayed_by: string | null;
      }>(
        `SELECT seq, json, received_at, relayed_by FROM inbox WHERE received_at = ? ORDER BY seq`,
        receivedAt,
      )
      .toArray();
    const row =
      seqLow !== null
        ? (rows.find((r) => r.seq % 32768 === Number(seqLow)) ?? rows[0])
        : rows[0];
    if (!row) return json(404, { error: "not found" } as JsonValue);
    return json(200, {
      seq: row.seq,
      receivedAt: row.received_at,
      activity: JSON.parse(row.json) as JsonValue,
      relayedBy: row.relayed_by,
    } as unknown as JsonValue);
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
