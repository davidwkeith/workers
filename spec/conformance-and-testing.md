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
