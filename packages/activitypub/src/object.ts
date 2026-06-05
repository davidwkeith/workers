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
} from "./as2";
import { ApOutcome, OUTCOME_ACTIVITY_HEADER, OUTCOME_HEADER } from "./log";
import { INTERNAL_HEADERS, type ForwardedConfig } from "./config";
import {
  assertPublicHttpsTarget,
  deliverActivity,
  DeliveryBlockedError,
} from "./delivery";
import type { ActivityPubEnv } from "./config";

/** How long a seen activity `id` is remembered for dedup (7 days). */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Max delivery rows processed per alarm wake. */
const DELIVERY_BATCH = 20;
/** Timeout (ms) bounding any single outbound fetch (actor lookup / delivery). */
const OUTBOUND_TIMEOUT_MS = 10_000;

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
         actor TEXT PRIMARY KEY, inbox TEXT, added_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS following (
         actor TEXT PRIMARY KEY, state TEXT NOT NULL, added_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS inbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, json TEXT NOT NULL,
         received_at INTEGER NOT NULL)`,
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
  }

  override async fetch(request: Request): Promise<Response> {
    const config = this.#readConfig(request);
    if (!config) return text(500, "missing internal config");
    this.#config = config;
    this.#persistDeliveryConfig(config);

    const url = new URL(request.url);
    const path = url.pathname;
    const iris = config.iris;
    const method = request.method.toUpperCase();

    // Internal routes the front door constructs (never reachable externally).
    if (path === `${pathOf(iris.id)}/__stats`) return this.#stats();
    if (path === `${pathOf(iris.id)}/__deliver`) {
      const due = await this.#processDeliveries();
      return json(200, { processed: due });
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
      case "Announce":
        this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
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
   * by enqueuing a signed `Accept` delivered to the follower's inbox. The
   * follower's inbox is resolved from its actor document.
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

    const inbox = await this.#resolveInbox(follower);
    if (!inbox) return;
    this.#sql.exec(
      `UPDATE followers SET inbox = ? WHERE actor = ?`,
      inbox,
      follower,
    );

    const accept: Record<string, JsonValue> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${config.iris.id}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: config.iris.id,
      object: activityAsObject(activity),
    };
    this.#enqueueDelivery(inbox, JSON.stringify(accept));
    // Don't deliver inline — that would block the peer's POST on our outbound
    // network. Arm the alarm; the single alarm worker is the only delivery
    // driver, so retries never race a second concurrent pass.
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

  #storeInbox(activity: ActivityObject): void {
    const id =
      typeof activity.id === "string" ? activity.id : crypto.randomUUID();
    this.#sql.exec(
      `INSERT OR IGNORE INTO inbox (id, json, received_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.now(),
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
   * follower's inbox. A bare object (e.g. a `Note`) is wrapped in a `Create`.
   * The front door has already authorized this request via the publish token.
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
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) this.#enqueueDelivery(row.inbox, body);
    }
    // Fan-out runs in the background alarm worker, not inline, so a large
    // follower set never slows the owner's publish response.
    await this.#armAlarm();

    return json(201, activity as JsonValue, { location: id });
  }

  /** Wrap a bare object in a `Create`, assign ids/audience, and timestamp it. */
  #asOutboxActivity(
    input: ActivityObject,
    iris: ActorIris,
  ): Record<string, JsonValue> {
    const isActivity =
      typeof input.type === "string" &&
      ["Create", "Update", "Delete", "Announce", "Like", "Follow"].includes(
        input.type,
      );
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
      try {
        const result = await deliverActivity(
          row.inbox,
          row.json,
          signer,
          fetch,
          () => Date.now(),
        );
        if (result.ok || !result.retryable) {
          this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
        } else {
          this.#rescheduleOrDrop(row.seq, row.attempts);
        }
      } catch (error) {
        if (error instanceof DeliveryBlockedError) {
          // Unsafe target — never reachable; drop it.
          this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, row.seq);
        } else {
          this.#rescheduleOrDrop(row.seq, row.attempts);
        }
      }
    }

    await this.#armAlarm();
    return due.length;
  }

  #rescheduleOrDrop(seq: number, attempts: number): void {
    const next = attempts + 1;
    const max = this.#deliveryPolicy("deliveryMaxAttempts", 8);
    if (next >= max) {
      this.#sql.exec(`DELETE FROM delivery WHERE seq = ?`, seq);
      return;
    }
    const base = this.#deliveryPolicy("deliveryBaseDelayMs", 60_000);
    const delay = base * 2 ** attempts;
    this.#sql.exec(
      `UPDATE delivery SET attempts = ?, next_at = ? WHERE seq = ?`,
      next,
      Date.now() + delay,
      seq,
    );
  }

  /** Schedule the alarm for the earliest pending delivery, if any. */
  async #armAlarm(): Promise<void> {
    const next = this.#sql
      .exec<{
        next_at: number | null;
      }>(`SELECT MIN(next_at) AS next_at FROM delivery`)
      .one().next_at;
    if (next === null) return;
    await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    await this.#processDeliveries();
  }

  // -- helpers ---------------------------------------------------------------

  #stats(): Response {
    const localPosts = this.#count("outbox");
    return json(200, { users: 1, localPosts } as JsonValue);
  }

  /** Resolve a remote actor's `inbox` URL (sharedInbox preferred), or `null`. */
  async #resolveInbox(actor: string): Promise<string | null> {
    try {
      assertPublicHttpsTarget(actor);
    } catch {
      return null;
    }
    let response: Response;
    try {
      response = await fetch(actor, {
        headers: { accept: "application/activity+json" },
        // Bound the lookup so a slow/hung remote cannot pin the inbound request.
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
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
    const endpoints = record.endpoints;
    if (endpoints && typeof endpoints === "object") {
      const shared = (endpoints as Record<string, unknown>).sharedInbox;
      if (typeof shared === "string") return shared;
    }
    return typeof record.inbox === "string" ? record.inbox : null;
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
