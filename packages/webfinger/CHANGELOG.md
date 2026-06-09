# @dwk/webfinger

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
