# Conformance & testing

Interop is the bar. Partial LDP / WAC / content-negotiation support quietly
breaks real clients, so conformance is treated as a release gate, not a
nice-to-have.

## IndieWeb conformance

- [micropub.rocks](https://micropub.rocks/) — Micropub server tests.
- [webmention.rocks](https://webmention.rocks/) — Webmention sender/receiver
  tests.
- [Implementation reports](https://micropub.net/implementation-reports/) —
  publish results for `@dwk/micropub`.

## Solid conformance

- The Solid conformance test suites and real Solid clients. Interop with actual
  clients is the acceptance bar; the spec-derived requirements in
  [packages/solid-pod.md](packages/solid-pod.md) exist to reach it.

## WebDAV conformance

- [litmus](http://www.webdav.org/neon/litmus/) — the WebDAV (RFC 4918) test
  suite (`basic`, `copymove`, `props`, `locks`) — plus real Finder / Windows
  Explorer / davfs2 read-write mounts, against a deployed `@dwk/webdav` door
  (`createSolidPodWebdav`). litmus is a CLI, so the conformance dispatcher runs
  it directly (`run-suite.mjs webdav --target … `) given an app-password.

## Local testing

- [`wrangler dev`](https://developers.cloudflare.com/workers/wrangler/) +
  Miniflare / `workerd` under **vitest**.
- **Per-package unit tests.** Because `@dwk/wac`, `@dwk/rdf`, and `@dwk/dpop`
  take plain-data inputs, they unit-test without a Workers runtime.
- **Integration tests** that exercise the verb lifecycles, including at minimum:
  - authenticated `GET` routed through WAC,
  - `PATCH` with a `solid:where` match,
  - `PATCH` whose `where` does not bind (expect **409**),
  - `If-Match` / ETag preconditioned writes.

## Release gate

A package SHOULD NOT be published at a stable (`>=1.0.0`) version until it
passes the conformance suite(s) relevant to its standard and its integration
lifecycle tests are green.

### How the gate is wired (issue #12)

- **Source of truth:** [`conformance/status.json`](../conformance/status.json)
  records, per package, the status of each conformance suite and of the
  integration lifecycle tests (`pending` | `failing` | `passing` |
  `not-applicable`). See [`conformance/README.md`](../conformance/README.md).
- **Guard:** [`scripts/release-gate.mjs`](../scripts/release-gate.mjs)
  (`pnpm release:gate`) cross-checks every package's declared version against
  that file. Any package at a stable version (`major >= 1`, no prerelease tag)
  whose suites or integration status are not `passing`/`not-applicable` is a
  violation, and the gate exits non-zero. It runs inside `pnpm release` **before**
  `changeset publish`, so a stable publish is impossible until conformance is
  recorded green. 0.x packages are exempt. The guard is unit-tested via
  `pnpm test:gate`.
- **CI:** [`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml)
  runs the gate and the integration lifecycle tests (`pnpm test:integration`) on
  every PR/push. The hosted suites (micropub.rocks, webmention.rocks, Solid
  conformance) require a deployed, publicly reachable Worker, so they run on
  `workflow_dispatch`/schedule via
  [`scripts/conformance/run-suite.mjs`](../scripts/conformance/run-suite.mjs)
  against a target URL; their results are recorded back into `status.json`.
