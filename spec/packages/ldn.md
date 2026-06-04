# `@dwk/ldn`

| | |
|---|---|
| **Type** | endpoint (extraction candidate) |
| **Ships a DO?** | no (would reuse the `@dwk/solid-pod` DO when composed) |
| **Standard** | [Linked Data Notifications](https://www.w3.org/TR/ldn/) |
| **Status** | proposed — **decision needed** — tracked in [#63](https://github.com/davidwkeith/workers/issues/63) |

LDN defines a standard inbox: discovery via `ldp:inbox`, `POST` of an RDF
notification, and `GET` to list. The project **largely already implements this
inside [`@dwk/solid-pod`](solid-pod.md)** (LDP container + inbox semantics), so
this is primarily an **"extract, don't add"** evaluation rather than net-new
behaviour.

## Decision needed

Choose one:

1. **Extract** a reusable `@dwk/ldn` that both `@dwk/solid-pod` and
   [`@dwk/activitypub`](activitypub.md) (whose inbox is conceptually similar)
   consume.
2. **Leave** it inside `@dwk/solid-pod` — no separate package.
3. **Close** as already covered by Solid.

This is low priority relative to the federation and feed work; the package
should not be built until the direction is chosen.

## Functional requirements (if pursued)

- **Receiver:** accept a `POST` of an RDF notification to an inbox container,
  content-negotiated via [`@dwk/rdf`](rdf.md).
- **Discovery:** advertise the inbox with
  `Link rel="http://www.w3.org/ns/ldp#inbox"`.
- **Consumer:** `GET` the inbox listing.

## Design constraints

- **RDF-only and protocol-agnostic** — it MUST NOT pull in Solid-specific WAC
  assumptions, so it can back both the Solid inbox and the ActivityPub inbox
  (composition-contract confinement). Authorization stays the caller's concern.

## Bindings (declared `Env` fragment)

- Inbox storage: the `@dwk/solid-pod` DO namespace when composed, or D1 for a
  standalone deployment.

## Conformance / testing

- W3C LDN test suite. See
  [conformance-and-testing.md](../conformance-and-testing.md).
