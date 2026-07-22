# Mastodon client API phase 2 — implementation notes

Supplements the approved design in [`spec/mastodon-client-api.md`](../../../spec/mastodon-client-api.md)
(#327, PR #347) for phase 2 ([#349](https://github.com/davidwkeith/workers/issues/349)).
That document remains authoritative; this note records facts confirmed
against the actual `@dwk/activitypub` code and one scope decision made
against it, so the implementation plan doesn't silently diverge from what
was approved.

## Confirmed against the code

- **`inbox.seq`** already exists as `INTEGER PRIMARY KEY AUTOINCREMENT` — no
  schema migration needed for the cursor column itself. The design doc's "no
  schema change is required for v1" claim holds for this column.
- **`verify_state`** only ever takes `NULL` (direct), `'pending'`, or
  `'verified'` — a refuted relayed row is deleted outright
  (`#dropRelayedRow`), never marked `'failed'`. The design doc's `verify_state
= 'failed'` exclusion is defensive/belt-and-suspenders, not a real state
  the new routes need to branch on.
- **`object_type` reflects the embedded object's AS2 `type`, not the
  activity's own `type`**, and is populated only when `activity.object` is an
  embedded JSON object rather than a bare IRI. It is `NULL` for most `Like`
  rows and for `Announce` rows whose object is referenced by IRI. SQL alone
  cannot select "Announce rows" or "Like rows" this way — matches the design
  doc's own plan for read-time JSON classification, but with one added
  implication: the `__client/timeline` and `__client/notifications` DO routes
  must classify-and-fill rather than a single bounded `SELECT ... LIMIT ?`.
  **Implementation requirement:** fetch a batch by `seq` bound, parse each
  row's `json`, classify, keep matches, advance the cursor past the whole
  batch, and repeat until either `limit` matches are collected or the table
  is exhausted — otherwise pages silently come back short.
- **`__stats` has no internal-header gate** today (unlike `__inbox`/
  `__following`) because it already backs the unauthenticated NodeInfo route.
  Extending it additively with `followers`/`following`/`statuses` keeps that
  as-is; no new gating is introduced by this phase.
- **The adapter's data-fetch mechanism is `mcp-tools.ts`/`syndication.ts`'s
  pattern, not `createSolidPodWebdav`'s.** `createSolidPodWebdav` is the
  right precedent for the _export shape_ (a single `createX` factory in the
  DO-owning package), but its actual backend wiring is closures living
  _inside_ the DO class (`pod.ts`), which only works because `@dwk/webdav`'s
  backend consumer is the DO itself. `@dwk/mastodon-api` is a separate
  package with no DO code, so `createActivitypubMastodonApi`'s
  `MastodonBackend` implementation must instead build a synthetic `Request`
  to `${config.iris.id}/__client/...` carrying
  `INTERNAL_HEADERS.config` (via the existing `forwardedConfig` helper) and
  `INTERNAL_HEADERS.internal = "1"`, and call
  `actor.get(actor.idFromName(config.iris.id)).fetch(request)` — exactly what
  `createActivitypubMcpTools` and `createCommunitySyndicationTargets` already
  do for their own internal routes.

## Cursor contract: how the DO reconciles `seq` with lossy snowflake bits

The snowflake formula (`received_at_ms << 16 | source << 15 | seq & 0x7FFF`)
only preserves the **low 15 bits** of `inbox.seq`. For a table under 32768
rows the round-trip is exact by coincidence; past that it isn't — a naive
`WHERE seq = <decoded low bits>` on `__client/entry` lookup, or a naive
`WHERE seq < <decoded low bits>` cursor bound, would silently target the
wrong row once `seq` wraps past 32767. `received_at_ms`, by contrast, is
preserved **exactly** (only shifted, never masked).

**Resolution:** the new internal DO routes bound and locate rows by
`received_at` (exact, from the snowflake's high bits) with `seq` used only
as the same-millisecond tiebreak the design doc already describes — never as
a bare bound recovered from the snowflake's low bits alone:

- `__client/timeline` / `__client/notifications` cursor params:
  `max_received_at` / `since_received_at` / `min_received_at` (epoch ms) plus
  an optional `tie_seq` (the decoded `seq & 0x7FFF`) to break same-millisecond
  ordering — `ORDER BY received_at DESC, seq DESC`, `WHERE (received_at, seq)
< (max_received_at, tie_seq)` in the paginated direction actually queried.
  In the overwhelmingly common case (no two inbox rows share a millisecond)
  the tiebreak is unused.
- `__client/entry`: `GET <actor>/__client/entry?received_at=<ms>&seq_low=<n>`
  → `SELECT * FROM inbox WHERE received_at = ? AND (seq % 32768) = ? ORDER BY
seq LIMIT 1` — exact for any table size because `received_at` alone almost
  always identifies the row; `seq_low` only disambiguates a same-millisecond
  collision.

The adapter (`@dwk/activitypub`'s `createActivitypubMastodonApi`) owns both
directions of this translation: decoding a client-supplied snowflake
(`maxId`/`sinceId`/`minId`/single `id`) into `{receivedAtMs, seqLow15}`
before calling the internal route, and encoding a DO row's
`(receivedAt, seq)` into a snowflake when building the `BackendEntry` the
`@dwk/mastodon-api` protocol core sees. `@dwk/mastodon-api` itself never
computes `received_at`/`seq` — it only ever handles opaque decimal snowflake
strings, per the `MastodonBackend` seam's existing `maxId`/`sinceId`/`minId`
shape.

## Known gap: bare-IRI `Announce` objects render as empty statuses

`statusEntity` (Task 5, `entities.ts`) reads `activity.object`'s fields
(`content`, `summary`, `attachment`, …) assuming an embedded object. A
plain (non-relayed) `Announce`'s `object` is, per ordinary ActivityPub
practice, often just the boosted post's IRI as a **bare string** — indexing
into a string primitive returns `undefined` for every field (safe, no
crash, confirmed during Task 5's review), so such a row currently renders
as a content-less `Status` rather than the actual boosted post. This does
not block phase 2's acceptance bar (the pixelfed-qa step-4 like + reply are
favourite/mention notifications, not a boost-rendering case), so it is
left as a documented gap rather than fixed now — whoever owns the
DO-to-adapter seam should confirm whether `Announce` rows are denormalized
to an embedded shape before storage, or whether `statusEntity` needs a
`Create`-vs-plain-`Announce` branch that dereferences the boosted post
separately, before phase 3 relies on boosts rendering correctly.

## Scope decision: Follow notifications deferred to phase 3

`#onFollow` writes only to the `followers`/`pending_accept` tables — inbound
`Follow` activities never reach `inbox`. The design doc's notification
roster (`Follow` → `follow`) can't be satisfied by reading `inbox` alone
under the current write path, and phase 2 was scoped as "additive DO routes
only" — teaching `#onFollow` to also write an `inbox` row (or merging a
second `followers`-sourced stream into the notification cursor) is real
federation-write-path or pagination-model surgery, not the additive change
phase 2 promised.

**Decision (confirmed with the repo owner): defer Follow notifications to
phase 3 / #350.** Phase 2 ships `favourite`/`reblog`/`mention` notifications
only — this exactly covers the acceptance bar phase 2 was scoped against
(`conformance/pixelfed-qa.md` step 4: the like + reply are visible in a real
client). Follow-notification support is a known, documented gap until #350.

Consequence for implementation: the notification classifier in
`@dwk/mastodon-api`'s entity-mapping layer has no `Follow` case in phase 2;
`conformance/mastodon-client-qa.md` and `spec/packages/mastodon-api.md`
should note the gap explicitly rather than silently omitting it.
