# @dwk/indieauth

## 1.0.0-beta.2

### Patch Changes

- b1e0fc4: Wrap the handler's route dispatch in a try/catch so an unexpected exception
  (e.g. a D1 failure) returns a structured `server_error` OAuth response instead
  of crashing unhandled. Also add a runtime shape guard on the stored `profile`
  JSON before trusting it as `ProfileInfo`, instead of blind-casting it.
- ec0f4a2: Use `crypto.subtle.timingSafeEqual` for PKCE and HMAC signature comparison
  instead of a hand-rolled loop that short-circuited (and leaked timing) on a
  length mismatch.

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/dpop@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [dc59912]
- Updated dependencies [4cd36af]
  - @dwk/dpop@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- 3e505be: `authorization_codes` and `access_tokens` are now opportunistically reaped of
  expired rows on every new authorization-code save / token issuance, since
  this package has no cron entrypoint of its own to schedule the cleanup.
  Previously neither table was ever pruned, so both grew unbounded over a
  deployment's lifetime and slowed `isTokenActive`'s scan. Both tables now also
  have a supporting index on `expires_at`, so the new per-write prune is an
  index-range delete rather than a full-table scan on every save/issuance.
- bde0341: Create D1 schema lazily so a fresh deploy no longer 500s (#291, #292). The
  IndieAuth code/token store, the Micropub post store, and the Micropub/Microsub
  DPoP replay stores previously created their tables only in an `init()` that no
  handler ever called, so a consumer composing these packages against a brand-new
  D1 hit `no such table` on the first authorization/token/publish request, and —
  because DPoP replay-checking is on by default — every authenticated
  create/update/delete `500`ed permanently.

  Each store now materialises its schema lazily on first use (the same
  `ensureSchema` pattern the webmention/websub/microsub stores already use), with
  the cached init promise cleared on failure so a transient D1 error doesn't wedge
  the store. The IndieAuth RFC 8707 `resource`-column migration now runs on that
  lazy path too, so it actually reaches consumer databases. No separate migration
  step is required.

- Updated dependencies [3e505be]
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- 6d14fc3: Fix: emit explicit `.js` extensions on relative imports so the published ESM
  packages resolve under Node's ESM loader.

  The packages were built with `moduleResolution: "Bundler"`, which let source
  files omit extensions on relative specifiers (`export { createWebmention } from
"./handler"`). `tsc` preserves specifiers verbatim, so the published
  `dist/index.js` re-exported extensionless paths that Node's ESM loader cannot
  resolve — `import("@dwk/webmention")` failed with `ERR_MODULE_NOT_FOUND` (only
  a bundler like esbuild/wrangler papered over it). Relative specifiers across the
  monorepo now carry explicit `.js` extensions, and `tsconfig.base.json` moves to
  `module`/`moduleResolution: "NodeNext"` so the compiler enforces extensions and
  this cannot silently regress.

- Updated dependencies [6d14fc3]
  - @dwk/dpop@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/dpop@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/dpop@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 08cf029: Adopt the injectable `@dwk/log` logging and metrics seams in the remaining
  endpoint packages, so auth/authz decisions and validation rejections are no
  longer silently swallowed (see `spec/observability.md`). Each package now depends
  on `@dwk/log`, accepts an optional `logger` and `metrics` in its config
  (defaulting to no-ops), owns an exported event taxonomy, and passes the same
  `(event, fields)` to both seams. Redaction follows the cross-cutting policy:
  only machine-readable reason codes, hosts (`hostFromUrl`), HTTP method/status,
  and scopes are recorded — never tokens, codes, proofs, or bodies.
  - **`@dwk/indieauth`** (`IndieAuthLogEvent`): authorization rejections by reason
    (`client_id_invalid`, `redirect_uri_not_permitted`, `pkce_required`, …), code
    issuance, token issuance, token-endpoint rejections by reason
    (`invalid_grant`, `pkce_failed`, `dpop_invalid`, …), and revocations.
  - **`@dwk/micropub`** (`MicropubLogEvent`): authorization rejections by error
    code, validation rejections by reason (`invalid_body`, `media_too_large`,
    `missing_type`, …), action completions by verb, and media stored.
  - **`@dwk/solid-pod`** (`SolidPodLogEvent`): edge-authentication rejections by
    reason and acceptances are emitted by the stateless front door. Because a
    Durable Object cannot receive the injected seams across the isolate boundary,
    the DO signals its WAC denials, anonymous-write refusals, and DPoP replay
    rejections back to the front door via an internal `x-solid-outcome` response
    header; the front door — the composition boundary where the seams are wired —
    emits the matching events and strips the header before replying to the client.

- 589db69: Scan HTML with the Workers runtime's streaming `HTMLRewriter` instead of regex
  tag matching. A real tokenizer correctly ignores elements inside comments,
  handles attribute quoting, and never mistakes `data-href` for `href` — without
  pulling a parser into the bundle (`HTMLRewriter` is built into the runtime).

  Because `HTMLRewriter` is async and `workerd`-bound, the affected helpers are
  now async (and exercised under the Workers test pool rather than bare Node):
  - `@dwk/webmention`: `findWebmentionEndpoint`, `extractLinks`, and
    `sourceLinksTo` now return `Promise`s. The internal `stripComments`,
    `matchTags`, `getAttr`, and `resolveDocumentBase` regex helpers are replaced
    by a single `scanElements` primitive.
  - `@dwk/indieauth`: `parseRelMeLinks` and `relMeLinksBack` now return
    `Promise`s; the regex `rel=me` tag/attribute scanning is gone.

  Behaviour (including the webmention.rocks discovery conformance cases) is
  unchanged; only the helper signatures became async.

- 818c101: Add audience-restricted access tokens (RFC 8707 resource indicators / RFC 9700
  §2.3). Clients may now supply one or more `resource` parameters on the
  authorization request (and narrow them on the token request); the issued token
  then carries an `aud` claim naming the resource server(s) it may be presented
  to, so a token leaked to one resource server cannot be replayed at another. Each
  `resource` must be a well-formed absolute URI and pass the new optional
  `resourceIndicatorPolicy` config hook (defaults to accepting any well-formed
  resource); an unacceptable value is rejected with `invalid_target`. The audience
  is bound at authorization and may only be narrowed at the token endpoint.

  `verifyAccessToken` gains an optional `audience` option: when set, the token MUST
  carry an `aud` including that resource-server identifier, otherwise verification
  fails with the new `audience_mismatch` reason. Tokens with no `aud` and callers
  that pass no expected `audience` are unaffected, so this is backward compatible.

  The store's `init()` now performs an idempotent column migration (`ALTER TABLE
... ADD COLUMN resource`, guarded by `PRAGMA table_info`) so a durable D1
  database created before this change gains the new column instead of crashing
  with `no such column: resource`.

  Also clarifies (in docs only) that the IndieAuth "MUST contain a path component"
  rule for `client_id`/profile URLs is satisfied by construction — WHATWG URL
  parsing always yields at least a `/` path, which the spec accepts — so no
  explicit non-root check is applied.

- 2ef7e3c: Implement `@dwk/indieauth`: the authorization-code + PKCE flow, a D1-backed
  single-use authorization-code and issued-token store, DPoP-bound HS256 access
  tokens (bound via `@dwk/dpop`'s `cnf.jkt` and validatable by the Resource
  Server), profile-URL (`rel=me`) verification helpers, RFC 7009 revocation, and a
  discoverable OAuth 2.0 / IndieAuth server-metadata document. Authentication and
  consent are delegated to the deployer via `approveAuthorization`; authorization
  state lives in D1 (strongly consistent, never KV) and the handler fails loudly
  if the `AUTH_DB` or `TOKEN_SIGNING_KEY` bindings are missing.
- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.

### Patch Changes

- 6f446cd: Close four authorization-endpoint hardening gaps in `@dwk/indieauth` (issue
  #41):
  - **Granted scopes are now constrained to `scopesSupported`.** When the server
    advertises a non-empty `scopes_supported`, `issueCode` intersects the scopes
    from the approval hook (or request) against it, so neither a hook nor a client
    can have the server issue a scope it claims not to support — an over-broad
    scope here is a privilege concern because `@dwk/micropub` consumes these
    scopes for authz. An empty `scopesSupported` still means "no advertised
    constraint" and passes scopes through unchanged.
  - **The approved `me` is canonicalized.** `issueCode` now runs `approval.me`
    through `canonicalizeProfileUrl` and rejects the exchange (redirecting with
    `error=server_error`) when it does not yield a valid IndieAuth profile URL,
    rather than persisting/echoing the hook's value verbatim.
  - **DPoP `htu` is bound to the advertised token endpoint.** The token endpoint
    now verifies the proof against `config.tokenEndpoint` instead of
    `request.url`, so a path-rewriting proxy or differing public origin no longer
    mismatches the client's view of `token_endpoint` from the metadata document.
  - **`http:` `client_id`/`redirect_uri` are restricted to loopback hosts, and
    URL validation is hardened.** `isHttpUrl` now accepts plain `http` only for
    the loopback IPs (`127.0.0.1`, `[::1]`) for local development; every other
    client must use `https`, per the IndieAuth/OAuth native-app guidance. It also
    rejects embedded credentials, dot path segments, and non-loopback IP-literal
    hosts — mirroring the `canonicalizeProfileUrl` rules — so a confusable or
    unverifiable client identifier cannot slip through.

- 44e82b5: Require the `state` authorization-request parameter and always echo it. The
  IndieAuth authorization endpoint now rejects a request with a missing or empty
  `state` as `invalid_request` (once `redirect_uri`/`client_id` are validated, via
  the same redirect-error path as the missing-PKCE case) and sets `state` on both
  success and error redirects unconditionally, closing a CSRF-defense gap where
  `state` was treated as optional.
- Updated dependencies [cdda653]
- Updated dependencies [171749e]
- Updated dependencies [28a1693]
- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/dpop@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
