# `@dwk/activitypub` owner-admin endpoints: follower `Accept` + `Group` moderation

Issue: [#473](https://github.com/davidwkeith/workers/issues/473)

Scope note: this also covers exposing follower-request accept/reject through
`@dwk/mastodon-api`'s `follow_requests` write surface, so an off-the-shelf
Mastodon client (not just Anglesite) can manage pending follows — confirmed
with the repo owner as in-scope for this same effort, after establishing that
`Accept` has an established client-facing convention (see Design §3) while
`Group` moderation does not (no client implements it, so it stays
Anglesite-only via `/outbox`).

## Problem

Capability 4 (hosting `Group` actors, #376) shipped the *federated protocol*
side of membership approval and moderation — `manuallyApprovesFollowers`
config, and `Remove`-based moderation validated against an HTTP-signature-
verified `moderators` actor-IRI allowlist (`#onModerationRemove`,
`packages/activitypub/src/object.ts:886`) — but left no way for the **owner**
to trigger either one from outside the protocol.

- **Owner-publish** (`POST <actor>/outbox`, Bearer `publishToken`) only
  special-routes `Follow`/`Undo(Follow)` (`#routeRelationshipActivity`) and
  the follower-control set `Reject`/`Block`/`Undo(Block)`
  (`#routeFollowerControl`, #447). Any other activity type — including
  `Accept` and `Remove` — gets stored to the outbox and broadcast to every
  follower as ordinary content. `#onModerationRemove` only runs from the
  **inbound**, HTTP-signature-verified dispatch switch.
- Net effect: when `manuallyApprovesFollowers` is on, a pending follower is
  recorded in `followers` immediately (`#onFollow`,
  `packages/activitypub/src/object.ts:686-693`) but never gets the courtesy
  `Accept`. A `Group` owner has no way to ban a member or un-announce a post
  unless a genuinely separate third-party moderator's own AP server signs and
  delivers a `Remove` — which doesn't cover the primary case of an owner
  moderating their own hosted community from their own client (Anglesite).

## Non-goals

- **New HTTP routes on `@dwk/activitypub`'s own front door for `Accept`/
  `Remove`.** Both still route through the existing `POST <actor>/outbox`
  seam, already gated by the bearer `publishToken` in `handler.ts`. No
  changes to `handler.ts`, or `config.ts`'s `INTERNAL_HEADERS`, or
  `mcp-tools.ts`. (`@dwk/mastodon-api` *does* gain routes — see §3 — but
  those live in that package, reusing the `/outbox` seam internally rather
  than duplicating its logic.)
- **`Group` moderation through `@dwk/mastodon-api`.** No off-the-shelf client
  implements Group/community moderation (Mastodon has no concept of it), so
  there is nothing to gain by exposing `Remove` there. It stays exclusively
  on `/outbox`, for Anglesite.
- **Notifying a banned actor.** Matches existing inbound `#onModerationRemove`
  behavior: banning is local-only (drop from `followers`, insert into
  `banned`) with no outbound activity to the banned actor. Only un-announce
  fans out (`Undo(Announce)`, already implemented in `#removeAnnouncedPost`).
- **Cursor-paginated `follow_requests`.** Unlike timelines/notifications
  (snowflake `max_id`/`since_id`), the list is unpaged flat JSON — same
  precedent as the existing owner `GET <actor>/blocked` (#447): "a personal
  [list] is small, and capping it would silently hide [entries] from the
  only view of them there is."

## Design

The `Accept`/`Remove` cases live in `packages/activitypub/src/object.ts`,
using the exact same wire shapes the protocol already defines for the
equivalent inbound/third-party-moderator activities — so an owner client and
a federated peer construct these activities identically. §3 then exposes
`Accept`/`Reject` a second way — through `@dwk/mastodon-api` — by having that
package's adapter call the same DO seam internally, not by duplicating logic.

### 1. Owner `Accept` — confirm a pending follower

Wire shape mirrors `Reject`'s (`#rejectTarget`,
`packages/activitypub/src/object.ts:1465`): `object` is the follower's actor
IRI, the stored `Follow` id, or an embedded `{type: "Follow", actor: "<iri>"}`.

```json
{ "type": "Accept", "object": "https://follower.example/users/alice" }
```

- **New `followers.accepted_at` column** (nullable `INTEGER`, additive
  migration via `#ensureColumn`): `NULL` means still awaiting the owner's
  confirmation; non-`NULL` (the timestamp it happened) means confirmed —
  either because `manuallyApprovesFollowers` was off (auto-accept, set at
  insert time) or because the owner triggered this `Accept` action. This is
  new state, not present before this issue — see §3 for why it's needed (the
  `follow_requests` list) and the migration backfill it requires.
  `#onFollow`'s `INSERT INTO followers` sets `accepted_at` to `Date.now()`
  when `!config.manuallyApprovesFollowers`, else `NULL`; its `ON CONFLICT`
  clause becomes `SET follow_id = COALESCE(excluded.follow_id,
  followers.follow_id), accepted_at = COALESCE(followers.accepted_at,
  excluded.accepted_at)` — a re-`Follow` never un-sets an already-recorded
  acceptance, matching the existing `follow_id` COALESCE's "refresh without
  disturbing settled state" pattern immediately above it.
- **Rename `#rejectTarget` → `#singleFollowTarget`**: its target-resolution
  logic (bare string → look up by `followers.follow_id`, else treat as the
  actor IRI directly; embedded typed `Follow` → read `.actor`) is exactly
  what `Accept` needs too. No behavior change to the existing `Reject` call
  site, just a rename + a second caller.
- **Add an `Accept` branch to `#routeFollowerControl`** (renaming its doc
  comment to cover "single-target relationship activities" rather than only
  "follower-control"), structured like the `Reject` branch:
  1. Resolve the follower via `#singleFollowTarget`.
  2. **Require an existing `followers` row** for that actor (`SELECT
     follow_id FROM followers WHERE actor = ?`) — unlike `Reject`'s looser
     drift-repair fallback, confirming a follow that was never recorded
     doesn't make sense. No row ⇒ no-op (return `false`), matching the
     "unroutable → dropped" convention the other branches already use.
  3. `UPDATE followers SET accepted_at = COALESCE(accepted_at, ?) WHERE
     actor = ?` (now, follower) — applied unconditionally once a row is
     found, same as every other branch's local-state-always-applies rule
     (independent of `deliver`/`?skipDelivery=1`, which only gates the
     outbound notification below).
  4. Normalize `activity.object` to the canonical `Accept(Follow)` shape
     using the row's `follow_id` when present (same pattern `Reject` uses),
     `addressPrivately` to the follower alone, and — unless `deliver` is
     `false` (`?skipDelivery=1`) — `#enqueuePendingDelivery` + report `true`
     so `#publish` arms the alarm.
- **`isFollowerControlActivity`** gains `"Accept"` to its recognized set (and
  an updated doc comment) so `#publish` routes it away from outbox storage
  and follower fan-out, exactly like `Reject`/`Block`/`Undo(Block)` today.

Not `Group`-gated: manual follower approval is a general `Person`/`Group`
capability (spec "Members are followers ... including the
`manuallyApprovesFollowers` approval gate"), so `Accept` works for both actor
types.

### 2. Owner `Remove` — ban a member / un-announce a post

Wire shape is **identical** to the existing moderator-signed `Remove`
(`#onModerationRemove`): `target` disambiguates ban vs. un-announce, `object`
names the member or the `Announce` id.

```json
{ "type": "Remove", "object": "<member-iri>", "target": "<iris.followers>" }
{ "type": "Remove", "object": "<announce-id>", "target": "<iris.outbox>" }
```

- **Extract the shared core.** `#onModerationRemove`'s body *after* its
  authorization check becomes `#applyModerationRemove(activity, config,
  deliver: boolean)`:
  ```ts
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
      // ban: unchanged from today's #onModerationRemove body
      ...
      return;
    }
    if (target === config.iris.outbox) {
      await this.#removeAnnouncedPost(object, config, deliver);
    }
  }
  ```
  `#onModerationRemove` (inbound path) keeps its own
  `config.moderators.includes(moderator)` check, then calls
  `#applyModerationRemove(activity, config, /* deliver */ true)` — inbound
  moderation has no backfill concept, so it always delivers.
- **`#removeAnnouncedPost` gains a `deliver: boolean = true` parameter**: the
  outbox delete + inbox tombstone always apply; the `Undo(Announce)`
  fan-out loop + `#armAlarm()` are skipped when `deliver` is `false`.
- **New branch in `#publish()`**, placed immediately after the existing
  `isFollowerControlActivity` check and before the outbox `INSERT` — same
  position in the function, same reason (never stored to the publicly-served
  outbox, never broadcast). `Remove` is *not* added to
  `isFollowerControlActivity` itself — its delivery model differs: ban has
  no delivery at all, and un-announce's fan-out is a broadcast to the whole
  membership, not a single target:
  ```ts
  if (activity.type === "Remove") {
    if (config.actorType !== "Group") {
      return text(400, "`Remove` moderation requires a Group actor");
    }
    await this.#applyModerationRemove(activity, config, !skipDelivery);
    return json(202, activity as JsonValue);
  }
  ```
  No `config.moderators` check here — bearer `publishToken` auth at the
  front door is authorization enough; the owner is implicitly the top
  moderator of their own actor. This is a real behavioral difference from
  the inbound path, not just a convenience: an owner `Remove` succeeds even
  when `moderators` is empty or doesn't list the owner's own actor IRI.

The explicit `400` on a non-`Group` actor (rather than the inbound path's
silent drop) is a deliberate asymmetry: the inbound path stays opaque to an
unauthorized/inapplicable third party by design, but an owner client making
a real mistake (calling this on a `Person` actor) deserves a clear answer.

### 3. `@dwk/mastodon-api` `follow_requests` write surface

Real Mastodon clients (Tusky, Ivory, Elk, Pixelfed's app) manage pending
follows through a specific, well-known signature: `GET
/api/v1/follow_requests`, `POST /api/v1/follow_requests/:id/authorize`,
`POST /api/v1/follow_requests/:id/reject`. `stubs.ts` already stubs the list
route as permanently empty (`{ path: "/api/v1/follow_requests", auth: true,
body: [] }`); this replaces that stub with a real, backend-driven route and
adds the two write routes, following the exact `config.allowWrites` +
`write`-scope pattern `statuses-write.ts` already established for `POST
/api/v1/statuses` (spec/packages/mastodon-api.md § Write surface).

**Migration backfill (required for correctness).** `#ensureColumn` currently
returns `void`; it needs to report whether it *just* added the column, so
the DO can backfill existing rows exactly once:

```ts
#ensureColumn(table: string, column: string, type: string): boolean {
  const columns = this.#sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (columns.some((c) => c.name === column)) return false;
  this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}
```
```ts
if (this.#ensureColumn("followers", "accepted_at", "INTEGER")) {
  // Every pre-existing row predates this column and has no other stored
  // signal of whether it was genuinely still pending at migration time —
  // treat all of them as already-settled (their `added_at`) rather than
  // surfacing years of ordinary auto-accepted followers as false "pending"
  // requests. Accepted, narrow edge case: a follower who really was still
  // awaiting manual approval at the exact moment of upgrade reads as
  // already-accepted afterward — a one-time migration artifact, not an
  // ongoing behavior change.
  this.#sql.exec(`UPDATE followers SET accepted_at = added_at WHERE accepted_at IS NULL`);
}
```
This must run only inside the `if` — i.e., only the one time the column is
actually added — never on every constructor call, or it would silently
re-confirm every currently-pending follower on every DO cold start.

**New internal DO route** (`__client/follow_requests`, gated by
`INTERNAL_HEADERS.internal`, matching `__following`/`__inbox`): unpaged, like
`#listBlocked`:
```ts
#listFollowRequests(): Response {
  const items = this.#sql
    .exec<{ actor: string; added_at: number }>(
      `SELECT actor, added_at FROM followers WHERE accepted_at IS NULL ORDER BY added_at ASC`,
    )
    .toArray();
  return json(200, { items, total: items.length } as unknown as JsonValue);
}
```

**`MastodonBackend` gains two members** (`packages/mastodon-api/src/backend.ts`),
both optional (degrade gracefully, matching `publishStatus?`/`ownStatuses?`):
```ts
export interface BackendFollowRequest {
  readonly actor: string;
  readonly addedAt: number;
}
...
/** Pending follow requests, oldest first. Absent backend ⇒ route answers `[]`. */
followRequests?(): Promise<readonly BackendFollowRequest[]>;
/** Authorize or reject a pending follow request. `allowWrites`-gated like `publishStatus`. */
respondToFollowRequest?(actor: string, action: "authorize" | "reject"): Promise<void>;
```

**`@dwk/activitypub`'s adapter** (`packages/activitypub/src/mastodon-api.ts`,
`buildMastodonBackend`) implements them:
```ts
async followRequests() {
  const response = await stub().fetch(
    new Request(`${config.iris.id}/__client/follow_requests`, { headers: internalHeaders() }),
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { items: { actor: string; added_at: number }[] };
  return body.items.map((row) => ({ actor: row.actor, addedAt: row.added_at }));
},
async respondToFollowRequest(actor, action) {
  const headers = internalHeaders();
  headers.set(INTERNAL_HEADERS.publish, "1");
  headers.set("content-type", "application/json");
  const response = await stub().fetch(
    new Request(config.iris.outbox, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: action === "authorize" ? "Accept" : "Reject",
        object: actor,
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(`respondToFollowRequest failed (${response.status}): ${await response.text()}`);
  }
},
```
`respondToFollowRequest` is the key reuse: it POSTs directly to the DO's
`#publish` route (`config.iris.outbox`, internal fetch — the same
"trusted-caller-sets-the-internal-header-directly" pattern
`mcp-tools.ts`'s `activitypub_publish` already uses for `/publish`), carrying
a bare `{type: "Accept"|"Reject", object: <actor>}`. **`"reject"` needs zero
new DO logic** — it lands on the existing #447 `Reject` branch verbatim, the
same one `POST <actor>/outbox` already exposes to Anglesite. `"authorize"`
lands on §1's new `Accept` branch. One code path, two front doors.

**`@dwk/mastodon-api` route layer:**
- `entities.ts` gains `relationshipEntity(actorIri, { followedBy })` — a
  `Relationship` entity (`id` via the existing `encodeRemoteAccountId`,
  `following: false`, `followed_by`, `requested: false`, the rest of
  Mastodon's boilerplate `false`/empty fields), returned by both write
  routes.
- `handleFollowRequests` (new, `GET /api/v1/follow_requests`): authenticate +
  require an account-bound token (matching `handleNotifications`'s pattern —
  no scope check; reads aren't scope-gated in this package today). `if
  (!ctx.config.backend?.followRequests) return Response.json([])`. Otherwise
  map each `{actor, addedAt}` through the existing `remoteAccountEntity`
  (optionally enriched via `backend.actorProfile?.(actor)`, same as other
  read routes) and return the array — no `Link` header (unpaged, see
  Non-goals).
- `handleFollowRequestRespond` (new, shared by both write routes):
  `if (!ctx.config.allowWrites || !ctx.config.backend?.respondToFollowRequest)
  return recordNotFound()`; authenticate, require an account-bound token,
  `tokenHasScope(token.scope, "write:follows")` (Mastodon's real granular
  scope for this — `insufficientScope()` otherwise, matching
  `statuses-write.ts`'s exact structure); `decodeRemoteAccountId(id)` — `404`
  if it doesn't decode; call the backend method; respond with
  `relationshipEntity(actorIri, { followedBy: action === "authorize" })`.
- `handler.ts`: remove `/api/v1/follow_requests` from `stubs.ts`'s
  `STUB_ROUTES` (a real route now shadows it), add `["GET
  /api/v1/follow_requests", handleFollowRequests]` to `ROUTES`, and two
  `DYNAMIC_ROUTES` entries matching `/^\/api\/v1\/follow_requests\/([^/]+)\/
  (authorize|reject)$/`-shaped patterns (mirroring the existing
  `/^\/api\/v1\/statuses\/([^/]+)$/` dynamic-route convention) dispatching to
  `handleFollowRequestRespond(ctx, id, "authorize" | "reject")`.

### 4. Required fix: `#asOutboxActivity`'s activity allowlist

`#asOutboxActivity` (`packages/activitypub/src/object.ts:1642`) decides
whether caller input is "already a real activity" (passed through, actor/id
overwritten) or "a bare object" (wrapped in a synthetic `Create`). Its
`isActivity` list currently reads:

```ts
["Create", "Update", "Delete", "Announce", "Like", "Dislike", "Follow", "Undo", "Block", "Reject"]
```

`"Accept"` and `"Remove"` are missing. Without adding them, an owner-published
`Accept`/`Remove` gets wrapped inside a `Create` before the new `#publish`
branches ever see it — a required fix, not an enhancement.

## Data flow

```
Owner client (Anglesite)
  │ POST <actor>/outbox
  │ { "type": "Accept", "object": "<follower-iri>" }
  ▼
handler.ts — unchanged: bearer publishToken check, forwards to DO
  ▼
object.ts #publish
  - #asOutboxActivity: "Accept" ∈ isActivity ⇒ pass through, actor := iris.id
  - isFollowerControlActivity ⇒ true ⇒ #routeFollowerControl
    - #singleFollowTarget resolves the follower
    - followers row exists ⇒ normalize Accept(Follow), address privately
    - #enqueuePendingDelivery + #armAlarm()
  ▼
202 { the normalized Accept(Follow) activity }
  (delivered to the follower's inbox from the alarm, like every other
   outbound actor fetch)
```

```
Owner client (Anglesite)
  │ POST <actor>/outbox
  │ { "type": "Remove", "object": "<member-iri>", "target": "<iris.followers>" }
  ▼
handler.ts — unchanged
  ▼
object.ts #publish
  - #asOutboxActivity: "Remove" ∈ isActivity ⇒ pass through, actor := iris.id
  - activity.type === "Remove" branch (new, not via isFollowerControlActivity)
    - config.actorType !== "Group" ⇒ 400
    - #applyModerationRemove(activity, config, deliver=true)
      - target === iris.followers ⇒ DELETE followers, INSERT banned
  ▼
202 { the Remove activity }
```

```
Off-the-shelf Mastodon client (Tusky/Ivory/Elk)
  │ GET /api/v1/follow_requests
  ▼
mastodon-api handler.ts → handleFollowRequests
  - authenticate, require account-bound token
  - backend.followRequests() → mastodon-api.ts adapter
    → GET <actor>/__client/follow_requests (internal header)
    → object.ts #listFollowRequests: SELECT ... WHERE accepted_at IS NULL
  ▼
200 [ remoteAccountEntity(actor), ... ]   (unpaged)

  │ POST /api/v1/follow_requests/<id>/authorize
  │ Authorization: Bearer <write:follows token>
  ▼
mastodon-api handler.ts → handleFollowRequestRespond(..., "authorize")
  - allowWrites + write:follows scope check
  - decodeRemoteAccountId(id) → actorIri
  - backend.respondToFollowRequest(actorIri, "authorize")
    → mastodon-api.ts adapter: POST <actor>/outbox (internal, INTERNAL_HEADERS.publish=1)
      { "type": "Accept", "object": "<actorIri>" }
    → object.ts #publish → isFollowerControlActivity → #routeFollowerControl
      (§1's new Accept branch: same DO code the raw /outbox seam uses)
  ▼
200 { relationshipEntity(actorIri, { followedBy: true }) }
```

## Error handling

- Owner `Remove` on a non-`Group` actor → `400` with a precise message.
- Owner `Accept` for an actor with no `followers` row → silent no-op, `202`
  (matches the existing `Reject`/`Block` "unroutable → dropped" convention;
  this is a normal race — e.g. the follower unfollowed between the owner
  seeing the notification and clicking Accept — not an error condition).
- `?skipDelivery=1` behaves identically to today's documented meaning for
  `Reject`/`Block`: the local state change always applies; only the outbound
  federated notification is suppressed. For `Accept` that means no `Accept`
  is delivered; for `Remove`/un-announce it means no `Undo(Announce)`
  fan-out (the ban branch has no delivery to suppress either way).
- No new authorization surface on `@dwk/activitypub`'s own front door: both
  new activity types reach the DO only after the front door's existing
  bearer-token publish gate. `@dwk/mastodon-api`'s new routes add a
  genuinely new (but already-precedented) authorization surface: opaque
  bearer + `allowWrites` + `write:follows` scope for the two write routes,
  exactly mirroring `POST /api/v1/statuses`'s existing gate.
- `GET /api/v1/follow_requests` with no backend (or a backend missing
  `followRequests`) → `200 []`, matching `handleNotifications`'s existing
  degrade-gracefully convention.
- The two write routes, with `allowWrites` off or the backend missing
  `respondToFollowRequest` → `404`, matching `handleCreateStatus`.
- An unparseable/undecodable `:id` on either write route → `404`
  (`recordNotFound()`), not `400` — matches how an unknown resource id reads
  elsewhere in this package (`handleGetStatus`, `handleGetAccount`).

## Testing

Extend `packages/activitypub/src/object.test.ts` alongside the existing
`Reject` tests (~line 1764) and the moderator-`Remove` test (~line 2573):

- Owner `Accept` delivers a canonical `Accept(Follow)` to the follower's
  inbox alone (not broadcast), using the stored `follow_id` when present.
- Owner `Accept` accepts the actor-IRI shorthand, the stored `Follow` id, and
  an embedded `Follow` object — the same three shapes `Reject` accepts.
- Owner `Accept` no-ops (still `202`, no queued delivery, no alarm armed)
  when the actor has no `followers` row.
- Owner `Accept` with `?skipDelivery=1` applies no delivery (nothing to queue
  either way here, since there's no local state change on `Accept` — this
  test just confirms the header is honored without error).
- Owner `Remove` targeting `followers` bans the member (`followers` row
  gone, `banned` row present) without requiring the owner's actor IRI in
  `config.moderators`.
- Owner `Remove` targeting `outbox` un-announces: outbox row gone, inbox
  tombstoned (`removed_at` set), `Undo(Announce)` queued to every follower.
- Owner `Remove` with `?skipDelivery=1` on an un-announce: outbox/inbox
  mutations still apply, but no `Undo(Announce)` queued and no alarm armed.
- Owner `Remove` on a `Person` actor (default `actor.type`) answers `400`.
- Inbound moderator-signed `Remove` behavior is unchanged (existing tests at
  ~line 2573 and around `#onModerationRemove` continue to pass unmodified —
  a regression check that the extraction didn't change inbound semantics).
- `#asOutboxActivity` passes `Accept`/`Remove` through as real activities
  (not wrapped in a synthetic `Create`) — a direct unit test of the
  allowlist fix, since every behavioral test above would also silently fail
  in a confusing way if this regressed.
- **`accepted_at` migration**: a fresh DO (column added at construction,
  `#ensureColumn` returns `true`) with pre-existing `followers` rows
  (inserted directly via SQL, predating the column, as existing migration
  tests in this file already do for other additive columns) ends up with
  every row's `accepted_at = added_at`, not `NULL`. A *second* construction
  of the same DO (column already present) leaves a genuinely-`NULL` row
  `NULL` — the critical regression to guard: the backfill must not re-run.
- `#onFollow`: `accepted_at` is set at insert time under auto-accept
  (`!manuallyApprovesFollowers`), left `NULL` under manual approval, and a
  re-`Follow` of an already-accepted actor never resets it back to `NULL`.

Extend `packages/mastodon-api/src/*.test.ts`:

- `entities.test.ts`: `relationshipEntity` shape, both `followedBy` values.
- `handler.test.ts` / a new `follow-requests.test.ts`: `GET
  /api/v1/follow_requests` maps backend rows through `remoteAccountEntity`;
  `200 []` with no backend method. Both write routes: `404` with
  `allowWrites` off, `404` with no backend method, `403 insufficient_scope`
  with a `read`-only token, `404` on an undecodable id, `200` with the
  right `relationshipEntity` and the backend method called with the right
  `(actorIri, action)` on success. Route-table wiring: `/api/v1/
  follow_requests` no longer resolves through `stubRouteEntries()`.

Extend `packages/activitypub/src/mastodon-api.test.ts` (the adapter):

- `followRequests()` maps `__client/follow_requests`'s `{items}` shape to
  `BackendFollowRequest[]`; empty/failed response → `[]`.
- `respondToFollowRequest(actor, "authorize")` POSTs `{type: "Accept",
  object: actor}` to `config.iris.outbox` with `INTERNAL_HEADERS.publish`
  set; `"reject"` POSTs `{type: "Reject", ...}`; a non-`ok` DO response
  throws.

## Open questions

None — all design forks (HTTP surface choice for `Accept`/`Remove`; whether
owner `Remove` requires the owner's actor IRI in `config.moderators`;
whether to also expose follower-`Accept` through `@dwk/mastodon-api`'s
`follow_requests`) were confirmed with the repo owner during brainstorming.
