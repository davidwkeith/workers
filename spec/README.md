# `@dwk` IndieWeb + Solid — Technical Specifications

This directory decomposes the project requirements
([issue #1](https://github.com/davidwkeith/workers/issues/1), *Draft v0.3*)
into focused technical specifications. The issue is the source of truth for
**scope**; these documents are the source of truth for **how** each piece is
built and what "done" means.

## Reading order

| # | Document | Covers |
|---|----------|--------|
| 1 | [overview.md](overview.md) | Purpose, goals / non-goals, audience & usage model. |
| 2 | [architecture.md](architecture.md) | Monorepo layout, package taxonomy, the Worker → DO → R2 mental model, naming convention. |
| 3 | [composition-contract.md](composition-contract.md) | The cross-cutting rules that make packages composable: handler shape, bindings, config. |
| 4 | [non-functional-requirements.md](non-functional-requirements.md) | Consistency, runtime budget, security, observability, distribution, licensing. |
| 5 | [observability.md](observability.md) | The cross-cutting injectable-logging requirement and event-taxonomy conventions. |
| 6 | [conformance-and-testing.md](conformance-and-testing.md) | Conformance suites and local test strategy. |
| 7 | [open-questions.md](open-questions.md) | Deferred decisions and known limits. |

## Per-package specifications

| Package | Spec | Type |
|---------|------|------|
| `@dwk/indieauth` | [packages/indieauth.md](packages/indieauth.md) | endpoint |
| `@dwk/micropub` | [packages/micropub.md](packages/micropub.md) | endpoint |
| `@dwk/webmention` | [packages/webmention.md](packages/webmention.md) | endpoint |
| `@dwk/solid-pod` | [packages/solid-pod.md](packages/solid-pod.md) | endpoint + Durable Object |
| `@dwk/wac` | [packages/wac.md](packages/wac.md) | lib |
| `@dwk/dpop` | [packages/dpop.md](packages/dpop.md) | lib |
| `@dwk/rdf` | [packages/rdf.md](packages/rdf.md) | lib |
| `@dwk/log` | [packages/log.md](packages/log.md) | lib |
| `@dwk/store` | [packages/store.md](packages/store.md) | lib |

## Conventions used in these specs

Requirement strength follows [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119):
**MUST** / **MUST NOT** / **SHOULD** / **MAY**. Each spec lists the bindings and
config it requires so a provisioning app (or a developer's `wrangler.toml`) can
satisfy them declaratively.
