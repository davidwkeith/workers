# @dwk/indieauth

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
