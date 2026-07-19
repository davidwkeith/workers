---
"@dwk/activitypub": minor
"@dwk/webfinger": minor
---

FEP-1b12 group participation (fediverse interop phase 2, #275) and the
WebFinger client half (#277).

`@dwk/webfinger` gains `lookup.ts` — the pure client half of RFC 7033:
`parseHandle` (bare / `@user@host` / `!community@host` / `acct:` forms),
`webfingerQueryUrl`, `selectActorLink`, and `resolveHandle` with an injected
`fetch` (the package still makes no network calls of its own).

`@dwk/activitypub` participates in FEP-1b12 communities:

- **Follow-target typing (§2.1):** `following` rows record `actor_type`,
  `inbox`, and `shared_inbox`, resolved from the actor document off the
  critical path; pre-existing rows are lazily backfilled by the alarm tick
  (permanent failures mark `Unknown`), so old Group follows qualify without
  re-following. Owner-published `Follow` / `Undo(Follow)` now record the
  relationship and deliver to the target actor instead of fanning out.
- **Announce unwrapping (§2.2):** an `Announce` from a followed `Group`
  wrapping a member activity stores the inner activity attributed to its real
  author — deduped by inner id, tagged `relayed_by` + group `audience`.
- **Async two-tier origin verification, on by default (§2.2):** relayed
  content (`Create`/`Update`/`Delete`) verifies against its origin on the
  next alarm tick; votes (`Like`/`Dislike`) verify in batched sweeps.
  `verify_state` tracks `pending → verified`; a refuted row is deleted.
  Config: `verifyRelayedObjects: "tiered" (default) | "immediate" | "off"`.
- **Community posting (§2.3):** a shaped post with an `audience` Group is
  additionally delivered to the group's inbox (resolved from the alarm when
  unknown); the group announces it to members per FEP-1b12.
- **Community discovery (§2.4):** a handle-shaped `audience`
  (`!birding@lemmy.ml`) on `POST <actor>/publish` resolves to its Group actor
  IRI at the stateless front door via the `@dwk/webfinger` helper behind the
  SSRF guard.
- **`Dislike`** accepted inbound (stored like `Like`) and publishable
  outbound (with `Undo`).
