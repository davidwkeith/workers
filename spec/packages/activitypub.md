# `@dwk/activitypub`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** — the per-actor Durable Object class |
| **Standard** | [ActivityPub](https://www.w3.org/TR/activitypub/) + [ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-core/) |
| **Status** | implemented (unreleased) — tracked in [#58](https://github.com/davidwkeith/workers/issues/58) |

A native ActivityPub actor rooted at the user's own domain — making the
self-owned presence a first-class fediverse citizen (followers, replies, boosts)
rather than a bridged guest. ActivityStreams 2.0 is JSON-LD, so it reuses
[`@dwk/rdf`](rdf.md) directly, and the package mirrors the architecture proven
in [`@dwk/solid-pod`](solid-pod.md).

## Architecture fit

This is the **second package after `@dwk/solid-pod` to ship a Durable Object**.
A stateless Worker front door serves `GET` actor/collection reads and routes
`POST /inbox`; the per-actor DO is the consistency authority for the inbox,
outbox, follower/following collections, delivery queue, and activity-`id` dedup.
Per [non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing),
authoritative state **MUST** live in the DO (SQLite) — **never KV**. R2 holds any
large media; bodies **MUST** stream and **MUST NOT** be buffered in the DO.

- **Depends on [`@dwk/http-signatures`](http-signatures.md)** to sign outbound
  deliveries and verify inbound `POST /inbox` signatures.
- **Depends on [`@dwk/webfinger`](webfinger.md)** for actor discovery.

## Functional requirements

### Actor & collections

- Serve the **actor** document and the `inbox`, `outbox`, `followers`,
  `following` collections as paged `OrderedCollection`s. The actor document is
  served as `application/activity+json`, content-negotiating to the
  `application/ld+json; profile="…activitystreams"` variant when a strict client
  asks for it (§3.2).
- Optionally serve and advertise an instance-level **shared inbox** at
  `${baseUrl}/inbox` (§4.1 / §7.1.3) via `endpoints.sharedInbox`, so large peers
  can batch-deliver. Enabled by default; the single actor is the only recipient,
  so a batched delivery is processed for it.

### Server-to-server (federation)

- Inbound `POST /inbox`: verify the HTTP signature, dedup by activity `id`, and
  handle `Follow` / `Undo` / `Create` / `Update` / `Like` / `Announce` /
  `Delete`.
- Outbound delivery: fan out activities to follower inboxes with retry/backoff
  via **DO alarms** (and a Queue where composed), signing each request.

### NodeInfo

- The `/.well-known/nodeinfo` discovery document advertises both the
  `schema/2.0` and `schema/2.1` documents (many consumers still request 2.0),
  each largely-static and **static enough for Anglesite to serve**. Only the
  live `usage` counts are dynamic — decide per deployment whether those counts
  justify a Worker route or are omitted.

### Client-to-server (optional)

- C2S authoring is **out of scope for v1**; [`@dwk/micropub`](micropub.md)
  already covers authoring, and a publish → `Create` fan-out is the integration
  seam.

## Bindings (declared `Env` fragment)

- **Durable Object namespace** for the per-actor class (exported by this package).
- **R2 bucket** for media bodies.
- A **queue** (optional) for outbound delivery fan-out.

## Config

- `baseUrl` / domain (the actor identity root).
- Signing key material (secret binding) shared with the actor's published key.
- Delivery retry / backoff policy.

## Conformance

- ActivityPub test suites and real-world federation against Mastodon. JSON-LD via
  [`@dwk/rdf`](rdf.md) — confirm the AS2 context is covered by its v1 JSON-LD
  subset ([open-questions.md](../open-questions.md) §4). See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Open questions

- Authoring relationship with `@dwk/micropub` (publish → `Create`).
- Actor identity overlap with the eventual Solid-OIDC OP rooted at the same
  domain (see [open-questions.md](../open-questions.md) §1).
