# `@dwk/activitypub` outbox quiet-insert + backdated `published` (backfill support)

Issue: [#451](https://github.com/davidwkeith/workers/issues/451)

## Problem

Every path into the per-actor outbox DO (`POST <actor>/outbox` → `#publish`,
`POST <actor>/publish` → `#publishPost`, in `packages/activitypub/src/object.ts`)
unconditionally does two things a **backfill** use case can't tolerate:

1. **Immediate delivery fan-out.** `#publish`/`#storePost` insert into the
   `outbox` table, then unconditionally loop `SELECT inbox FROM followers ...`
   and enqueue delivery to every current follower (plus relationship routing
   for `Follow`/`Undo(Follow)` and community `audience` delivery). There is no
   way to insert without also notifying today's followers.
2. **`published` is always `now`.** `#asOutboxActivity` and `#storePost` both
   stamp `published: new Date().toISOString()`, discarding any caller-supplied
   value.

**Concrete use case:** Anglesite issue
[Anglesite/Anglesite-app#926](https://github.com/Anglesite/Anglesite-app/issues/926)
— syncing a site's *existing* content (posts that predate ActivityPub being
turned on) into its own outbox, so a Mastodon follower sees the site's real
history, not just posts made after activation. A literal backfill against the
current API notification-blasts every historical post to whoever follows the
site *today* — a non-starter.

## Non-goals

- **Idempotency of repeated backfill calls.** `#asOutboxActivity` and
  `#storePost` always mint a fresh server-assigned activity `id`
  (`crypto.randomUUID()`), so re-running a backfill batch for the same
  historical post creates a duplicate outbox entry — identical to today's
  live-publish behavior. Deduplication (tracking what's already been synced)
  is the calling app's responsibility, not this DO's.
- **`activitypub_publish` MCP tool** (`mcp-tools.ts`). That tool is explicitly
  a live, agent-facing, outward-facing write (its own description says so).
  Backfill is a trusted-owner-script operation against the existing
  `/outbox`/`/publish` HTTP seam, not an agent-callable capability.
- **`__client/publish`** (`#clientPublish`, the Mastodon client API write
  path). Real-time client posting; not part of the backfill path.

## Design

### 1. Quiet-insert mode (`skipDelivery`)

A `?skipDelivery=1` query parameter on the existing owner-publish endpoints:
`POST <actor>/outbox` and `POST <actor>/publish`. Both are already gated by
the bearer publish token in `handler.ts`, so this adds no new auth surface.

`handler.ts` translates the query param into a new internal header at the same
point it already sets `INTERNAL_HEADERS.publish`:

```ts
// config.ts
export const INTERNAL_HEADERS = {
  ...
  /** Marks an owner-authorized quiet-insert publish (`?skipDelivery=1`) — see object.ts #publish/#storePost. */
  skipDelivery: "x-ap-skip-delivery",
} as const;
```

```ts
// handler.ts, in the owner-publish block
const extra: Record<string, string> = { [INTERNAL_HEADERS.publish]: "1" };
if (url.searchParams.get("skipDelivery") === "1") {
  extra[INTERNAL_HEADERS.skipDelivery] = "1";
}
```

This mirrors the existing trust-boundary pattern (`publish`, `internal`,
`signedActor`): a header the front door sets from a request it has already
authorized, which the DO trusts without re-validating.

In `object.ts`:

- **`#publish`**: after `INSERT OR IGNORE INTO outbox`, check
  `request.headers.get(INTERNAL_HEADERS.skipDelivery) === "1"`. When true,
  return `json(201, activity, { location: id })` immediately — skip
  `#routeRelationshipActivity`, the follower-inbox loop, `#deliverToAudience`,
  and `#armAlarm()` entirely. A backfilled activity is historical content, not
  a live state change, so relationship routing (Follow → `following` table)
  and community delivery are skipped too, not just the follower loop.
- **`#storePost`**: gains an `opts: { skipDelivery?: boolean }` parameter.
  `#publishPost` reads the same header and passes it through; `#clientPublish`
  never sets it, so its behavior is unchanged. When `skipDelivery` is set,
  `#storePost` skips the follower loop, `#deliverToAudience`, and
  `#armAlarm()`, but still inserts the row and returns the same
  `{ activityId, activity, seq, publishedAt }` shape.

### 2. Backdated `published`

A caller-supplied `published` (ISO-8601 string) is preserved instead of always
being overwritten, **independently of `skipDelivery`** — a caller backdating a
live-delivered post is unusual but harmless, and coupling the two adds
complexity for no safety benefit.

- **Raw AS2 (`/outbox`)**: `#asOutboxActivity(input, iris)` derives
  `published` once — `input.published` when it's a valid, parseable
  ISO-8601-ish string, else `new Date().toISOString()` — and uses that single
  value for both branches:
  - Already-an-Activity branch: the spread `...input` already carries
    `published` when supplied; the explicit `published` set after the spread
    becomes a no-op re-assignment of the same (now-validated) value instead of
    an overwrite with `now()`.
  - Bare-object-wrap branch: the same derived `published` is used for both the
    synthetic `Create` wrapper and the inner object, matching current
    behavior of "both get the same timestamp."
- **Shaped post (`/publish`)**: `PostInput` (`objects.ts`) gains
  `readonly published?: string`. `parsePostInput` validates it (parseable
  date, like the `inReplyTo`/`audience` IRI checks but with a date-parseability
  check instead of `isHttpUrl`) and returns a client-facing error otherwise.
  `#storePost` passes `input.published ?? new Date().toISOString()` as
  `ids.published` into `buildPostActivity`/`buildPostObject` — both already
  take `ids.published` generically, so no builder changes beyond threading the
  value through.
- **Validation**: a supplied `published` that fails `Number.isNaN(Date.parse(value))`
  is rejected with `400` and a precise message (`` `published` must be a valid
  ISO-8601 timestamp ``) on both endpoints — never silently defaulted to `now`
  when the caller supplied something unparseable.

### 3. Ordering nice-to-have: outbox by `published_at`

`#pageItems`'s outbox branch changes:

```sql
-- before
SELECT json FROM outbox ORDER BY seq DESC LIMIT ? OFFSET ?
-- after
SELECT json FROM outbox ORDER BY published_at DESC, seq DESC LIMIT ? OFFSET ?
```

So a backfilled post discovered in a later run (e.g. added to `Source/` after
newer real-time posts already synced) sorts into its historical position in
the `OrderedCollection` rather than always landing at the front by insertion
order. Ties (identical `published_at`, e.g. two backfilled posts published the
same instant, or two live posts) fall back to `seq DESC` for a stable,
deterministic order. `#count` and `#serveCollection` need no changes — total
count and page-size math are unaffected by row order.

## Data flow

```
Owner backfill script
  │  POST <actor>/publish?skipDelivery=1
  │  { kind: "note", content: "...", published: "2019-03-01T12:00:00Z" }
  ▼
handler.ts (front door)
  - validates bearer publishToken (unchanged)
  - reads url.searchParams.get("skipDelivery")
  - forwards to DO with INTERNAL_HEADERS.publish=1 (+ .skipDelivery=1 if set)
  ▼
object.ts #publishPost → #storePost(input, { skipDelivery: true })
  - parsePostInput validates `published` (400 if unparseable)
  - buildPostActivity(..., { published: input.published ?? now() })
  - INSERT INTO outbox (id, json, published_at)
  - skipDelivery=true ⇒ return immediately (no follower loop, no alarm)
  ▼
201 { ...Create activity with historical `published`... }
```

## Error handling

- Malformed `published` → `400` with a precise message, mirroring the existing
  `Malformed activity JSON` / `parsePostInput` error patterns. No new error
  categories.
- `skipDelivery=1` reaches the DO only for requests that already passed the
  bearer-token publish gate at the front door — no new authorization surface.
- Existing malformed-JSON / oversized-body / missing-publish-token handling on
  both endpoints is untouched.

## Testing

- **`object.test.ts`** (DO-level, header set directly — these tests bypass
  `handler.ts`):
  - `#publish` with `skipDelivery` header: outbox row inserted, `delivery`
    table stays empty, `following`/`pending_accept` untouched for a `Follow`
    input, `state.storage.getAlarm()` stays unset.
  - `#publish`/`#publishPost` preserve a valid caller `published` in both the
    stored `outbox.published_at` and the returned activity JSON, for both an
    already-an-Activity input and a bare-object input.
  - `#publish`/`#publishPost` 400 on an unparseable `published`.
  - `#pageItems` outbox ordering: insert rows with mismatched `seq` vs.
    `published_at` (directly via SQL, as existing tests do for `followers`)
    and assert page order follows `published_at DESC`.
- **`index.test.ts`** (end-to-end through `createActivityPub`, exercising the
  real front door): a `POST <actor>/outbox?skipDelivery=1` (and `/publish`)
  request reaches the DO with the translated header and results in zero
  `delivery` rows, verified indirectly via a subsequent alarm-processing call
  or a fresh `followers` row that receives no queued delivery.

## Open questions

None — all four design decisions (signal mechanism, skip scope, `published`
coupling, ordering) were confirmed with the repo owner during brainstorming.
