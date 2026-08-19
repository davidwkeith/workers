# `@dwk/activitypub` inbound `Flag` (report) review

Issue: [#489](https://github.com/davidwkeith/workers/issues/489)

## Problem

Group/actor moderation has an owner-triggerable path for `Accept` (confirm a
pending follower) and `Remove` (ban a member / un-announce a post), both added
by #473, plus a bearer-token way to list pending followers (#487). But there
is no primitive at all for the other half of moderation: reviewing inbound
reports.

An ActivityPub peer reports content or an actor by sending a `Flag` activity
to the target's inbox (`type: "Flag"`, `object` naming what's being reported,
`content` carrying the report reason). The inbound dispatch switch in the
Durable Object (`packages/activitypub/src/object.ts`) has no `case "Flag"` —
it falls through to the `default` branch, which is deliberately "liberal: an
unknown activity is accepted (and ignored)". A `Flag` is currently ack'd with
a `202` and then silently dropped: never stored, never surfaced to the owner.

## Non-goals

- **`@dwk/mastodon-api` integration.** Mastodon's real admin reports API needs
  a staff-role concept this package doesn't have, and the issue doesn't ask
  for it. Same reasoning #473's design doc used to keep `Group` moderation
  Anglesite-only: no off-the-shelf client convention to gain by exposing this
  there. Stays reachable only via `/outbox` and the new `/reports` route,
  both already gated by the owner's `publishToken`.
- **New HTTP route for resolving a report.** Like `Accept`/`Remove`, the
  resolve action rides the existing `POST <actor>/outbox` seam — what the
  owner is asking for _is_ an AS2 activity, not a bespoke REST call.
- **Forwarding/relaying `Flag` activities.** Unlike `Like`/`Dislike`/
  `Announce`, a stored `Flag` never calls `#maybeForward` — a report must
  never fan out to followers or anyone else, even if it happened to name the
  followers collection as its audience. This is a deliberate divergence from
  the other `#storeInbox` callers, not an oversight.
- **Notifying the reporter when a report is resolved.** Matches the existing
  ban behavior (`#applyModerationRemove`'s ban branch): purely local
  bookkeeping, no outbound activity.

## Design

### 1. Store inbound `Flag`

Add to the inbound dispatch switch in `#handleInbox`:

```ts
case "Flag":
  await this.#storeInbox(activity);
  break;
```

Same `#storeInbox` call `Like`/`Dislike`/`Announce` already use — no new
storage primitive — but deliberately **not** followed by `#maybeForward`
(see Non-goals).

### 2. Two new `inbox` columns

Additive migration via `#ensureColumn`, alongside the existing
`object_type`/`audience`/`relayed_by`/`verify_state`/`removed_at` columns:

```ts
this.#ensureColumn("inbox", "type", "TEXT");
this.#ensureColumn("inbox", "resolved_at", "INTEGER");
```

- **`type`** — the activity's own top-level AS2 `type`, populated going
  forward by `#storeInbox`. The existing `object_type` column classifies the
  _embedded_ object (`activity.object`'s type), not the activity itself, so
  it cannot distinguish a `Flag` — the same limitation `#classifyClientEntry`
  documents ("`object_type` alone can't distinguish these ... is null for
  bare-IRI objects like most `Like`s"). No backfill needed: no `Flag` was
  ever stored before this feature (it hit the `default` case and was
  dropped), so there is no historical row a NULL `type` could misclassify —
  every pre-existing row simply predates this column and was never a report.
- **`resolved_at`** — mirrors `removed_at`'s tombstone pattern. `NULL` means
  still open; a timestamp means the owner dismissed/resolved it.

`#storeInbox` gains one line writing `activity.type` into the new column
(`typeof activity.type === "string" ? activity.type : null`).

### 3. `GET <actor>/reports`

New bearer-gated route, wired identically to `/blocked` (#447) and
`/follow_requests` (#487) in both `handler.ts` (bearer `publishToken` check,
`404`-not-`405` on the wrong verb, `404` when publishing is disabled) and
`object.ts`'s `#route`. Unlike those two — unpaged flat lists, because a
personal blocklist/approval-queue is expected to stay small — `/reports` is
**page/pageSize-paginated**, like `#listInbox`, because reports arrive from
arbitrary peers and a hostile one could flood them:

```ts
#listReports(request: Request): Response {
  // page/pageSize parsing identical to #listInbox
  const total = this.#sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inbox WHERE type = 'Flag' AND resolved_at IS NULL`,
    )
    .one().n;
  const items = this.#sql
    .exec<{ json: string }>(
      `SELECT json FROM inbox WHERE type = 'Flag' AND resolved_at IS NULL
         ORDER BY seq DESC LIMIT ? OFFSET ?`,
      pageSize,
      offset,
    )
    .toArray()
    .map((row) => JSON.parse(row.json) as JsonValue);
  return json(200, { items, total, page, pageSize } as JsonValue);
}
```

Returns the raw AS2 `Flag` JSON (matching `#listInbox`'s shape) rather than a
narrowed projection — the owner needs the reporter (`actor`), the reported
target (`object`), and the free-text reason (`content`) in full, and `object`
can be a bare IRI, an array, or an embedded object depending on the peer.

### 4. Resolve/dismiss a report

Rides the existing owner-publish seam, exactly like `Accept`/`Remove`:

```json
{ "type": "Ignore", "object": "<flag-activity-id>" }
```

AS2's `Ignore` ("Indicates that the actor is ignoring the object") is the
closest core-vocabulary fit for "this report needs no further action" — the
same reasoning that picked `Remove`/`Accept` for the other owner-admin
primitives rather than inventing new vocabulary.

New branch in `#publish()`, placed like the `Remove` branch — its own
top-level check, not folded into `isFollowerControlActivity` (whose
single-actor-targeted delivery model doesn't apply here: `Ignore(Flag)` never
delivers to anyone):

```ts
if (activity.type === "Ignore") {
  const target = objectId(activity.object);
  if (target) {
    this.#sql.exec(
      `UPDATE inbox SET resolved_at = COALESCE(resolved_at, ?)
         WHERE id = ? AND type = 'Flag'`,
      Date.now(),
      target,
    );
  }
  return json(202, activity as JsonValue);
}
```

No `Group` gating (unlike `Remove`) — reports apply to `Person` actors too.
An unknown id, an id that isn't a stored `Flag`, or an already-resolved
report all silently no-op (`UPDATE` affects zero rows) and still answer
`202` — the same "unroutable → dropped" convention `Accept`/`Reject`/`Block`
already use for a normal race (e.g. the report was already resolved through
another client).

### 5. Required fix: `#asOutboxActivity`'s activity allowlist

Same fix #473's design doc made for `Accept`/`Remove`: `#asOutboxActivity`
decides whether owner input is "already a real activity" (passed through) or
"a bare object" (wrapped in a synthetic `Create`). `"Ignore"` must be added to
its `isActivity` list, or an owner-published `Ignore` gets wrapped in a
`Create` before the new `#publish` branch ever sees it.

## Data flow

```
Remote peer
  │ POST <actor>/inbox   (HTTP-signature-verified by the front door)
  │ { "type": "Flag", "actor": "<reporter>", "object": "<reported-iri>",
  │   "content": "spam" }
  ▼
object.ts #handleInbox
  - case "Flag": #storeInbox(activity)   (type='Flag' stored, no #maybeForward)
  ▼
202
```

```
Owner client (Anglesite)
  │ GET <actor>/reports?page=1
  │ Authorization: Bearer <publishToken>
  ▼
handler.ts — bearer check, forwards to DO
  ▼
object.ts #listReports
  - SELECT ... WHERE type = 'Flag' AND resolved_at IS NULL ORDER BY seq DESC
  ▼
200 { items: [ <Flag activity>, ... ], total, page, pageSize }
```

```
Owner client (Anglesite)
  │ POST <actor>/outbox
  │ { "type": "Ignore", "object": "<flag-activity-id>" }
  ▼
handler.ts — unchanged: bearer publishToken check, forwards to DO
  ▼
object.ts #publish
  - #asOutboxActivity: "Ignore" ∈ isActivity ⇒ pass through, actor := iris.id
  - activity.type === "Ignore" branch (new)
    - UPDATE inbox SET resolved_at = now() WHERE id = <flag-activity-id> AND type = 'Flag'
  ▼
202 { the Ignore activity }
```

## Error handling

- `GET <actor>/reports` with no `publishToken` configured → `404` (matches
  `/blocked`/`/follow_requests`, not `405` — a private route must not confirm
  its own existence to an unauthorized prober).
- `GET <actor>/reports` with a bad/missing bearer token → `401`.
- `GET <actor>/reports` with any verb other than `GET` → `404` (same
  asymmetry as `/blocked`).
- Owner `Ignore` for an id with no matching open `Flag` row → silent no-op,
  `202` (normal race, not an error — see Design §4).
- No new authorization surface: `Ignore` reaches the DO only after the
  front door's existing bearer-token publish gate, same as every other
  owner-publish activity type.

## Testing

Extend `packages/activitypub/src/object.test.ts` alongside the existing
`Remove`/`Accept` tests:

- Inbound `Flag` is stored in `inbox` with `type = 'Flag'`, reachable via
  `#listInbox`/`__inbox` like any other stored activity.
- Inbound `Flag` addressed to the followers collection is **not** forwarded
  (`#maybeForward` not invoked — no delivery queued, no alarm armed from
  this path).
- `GET <actor>/reports` returns only unresolved `Flag` rows, newest first,
  paginated (`page`/`pageSize` honored like `/outbox`).
- `GET <actor>/reports` excludes non-`Flag` inbox rows (a `Like`/`Announce`
  stored alongside it never appears).
- `GET <actor>/reports` with no `publishToken` configured → `404`; wrong
  bearer → `401`; non-`GET` → `404`.
- Owner `Ignore` sets `resolved_at` on the matching `Flag` row, and a
  resolved report drops out of `GET <actor>/reports`.
- Owner `Ignore` on an unknown/already-resolved id is a no-op — still
  `202`, `resolved_at` unaffected (or already set).
- Owner `Ignore` is never written to the outbox and never queues a delivery
  (no alarm armed).
- `#asOutboxActivity` passes `Ignore` through as a real activity, not
  wrapped in a synthetic `Create` — direct unit test of the allowlist fix.
- **`type`/`resolved_at` migration**: a fresh DO run against a database
  with pre-existing `inbox` rows (inserted directly via SQL, predating both
  columns) leaves them with `type IS NULL` and excluded from
  `GET <actor>/reports` (they are not, and never were, `Flag` rows).

## Open questions

None — this closes the same class of gap #473/#487 already closed for
`Accept`/`Remove`/pending-follower listing, using the same seams.
