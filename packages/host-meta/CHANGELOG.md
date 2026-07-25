# @dwk/host-meta

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1
  - @dwk/webfinger@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/webfinger@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- Updated dependencies [0e65ce3]
- Updated dependencies [96cc2d3]
- Updated dependencies [3e505be]
  - @dwk/webfinger@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [6d14fc3]
  - @dwk/log@0.1.0-beta.3
  - @dwk/webfinger@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2
  - @dwk/webfinger@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1
  - @dwk/webfinger@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 15720ac: Add `@dwk/host-meta` — a Web Host Metadata (RFC 6415) discovery endpoint,
  mountable at `/.well-known/host-meta` and `/.well-known/host-meta.json`.
  - **`createHostMeta(config)`** returns the standard
    `(request, env, ctx) => Promise<Response>` handler. The host-wide document is
    config-supplied — a `webfingerUrl` that seeds an `lrdd` link templated to
    `…?resource={uri}`, plus optional static top-level `links` (and an optional
    `subject`/`properties`) — never read from the global environment. Fails loudly
    when neither a WebFinger URL nor any link is configured.
  - **XRD ⇄ JRD content negotiation** from the one URL (RFC 6415 §3): XRD
    (`application/xrd+xml`) by default, JRD (`application/jrd+json`) when the client
    prefers it. Selection priority is the `?format=` override, then the
    `host-meta.json` path (RFC 7033 §10.1, always JRD), then the `Accept` header
    (JRD only when strictly preferred over XRD). The two representations are
    information-equivalent.
  - The JRD link shaping is reused from `@dwk/webfinger` (the `Link` type);
    the XRD serializer (with `xsi:nil` for absent properties and nested
    `Title`/`Property` children, all XML-escaped) is the only new surface.
  - Permissive CORS (`Access-Control-Allow-Origin: *`) and `Vary: Accept` on every
    response; `OPTIONS` preflight and `HEAD` supported, other methods `405`.
  - Pure and **stateless**: no Durable Object, no D1, no required bindings; the
    request-invariant document is built once at construction and unit-tests under
    Node. Discovery events flow through the `@dwk/log` `Logger`/`Metrics` seams
    (`host-meta.served` with the negotiated `format`, `host-meta.rejected`).

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

- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
- Updated dependencies [ac7f340]
- Updated dependencies [d142211]
  - @dwk/log@0.1.0-beta.0
  - @dwk/webfinger@0.1.0-beta.0
