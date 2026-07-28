# @dwk/webfinger

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/safe-fetch@0.1.0-beta.4

## 0.1.0-beta.4

### Minor Changes

- 96cc2d3: FEP-1b12 group participation (fediverse interop phase 2, #275) and the
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

### Patch Changes

- 0e65ce3: Cap the number of batches scanned per client-list page — both the outbox
  owner-post merge into a Mastodon timeline and the inbox notifications scan —
  so a like/announce-dominated outbox or a plain-post-dominated inbox can no
  longer force a near-full-table scan per request. Also de-duplicate the
  cancellable timeout-signal helper: `@dwk/safe-fetch` now exports
  `createTimeoutSignal`, reused by `@dwk/activitypub` and `@dwk/webfinger`
  instead of each carrying its own copy.
- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [6d14fc3]
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- ac7f340: Add `@dwk/webfinger` — a WebFinger (RFC 7033) discovery endpoint, mountable at
  `/.well-known/webfinger`.
  - **`createWebfinger(config)`** returns the standard
    `(request, env, ctx) => Promise<Response>` handler. The `resource → JRD`
    mapping is config-supplied — a static `resources` map, a dynamic `resolve`
    function, or both (the map is consulted first) — never read from the global
    environment. Fails loudly when neither is configured.
  - **Spec-correct dispatch:** `resource` absent → `400`; a resource this server
    does not control → `404`; a match → `200` with an `application/jrd+json` body
    whose `subject` echoes the queried URI (any scheme, for fediverse interop).
  - **`rel` filtering** (repeatable) scopes the `links` array; `aliases` and
    `properties` are unaffected. Permissive CORS (`Access-Control-Allow-Origin: *`)
    on every response per §10.2; `OPTIONS` preflight and `HEAD` supported, other
    methods `405`.
  - **Case-insensitive matching** on the scheme and host per RFC 7033 §4.1 (the
    `acct:` local part stays case-sensitive); the echoed `subject` keeps the
    client's literal spelling.
  - Pure and **stateless**: no Durable Object, no D1, no required bindings; unit-
    tests under Node. Discovery events flow through the `@dwk/log`
    `Logger`/`Metrics` seams with the queried `resource` reduced to its host.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- d142211: Return `400` (not `404`) for a present-but-malformed `resource` query parameter,
  per RFC 7033 §4.2 ("If the 'resource' parameter is absent **or malformed** … the
  server … MUST indicate that the request is bad").

  A `resource` with no scheme (e.g. `alice@example.com`) or an unparseable
  `http(s)` URI previously fell through to the resolver and returned `404`; it now
  fails fast with `400` before any lookup. A new `isWellFormedResource` helper
  performs the minimal scheme/URI validation and is exported for reuse. The
  rejected-event vocabulary gains a `malformed_resource` reason.

- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
