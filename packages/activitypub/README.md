# `@dwk/activitypub`

> Edge-native ActivityPub actor: inbox/outbox, follower collections, signed
> server-to-server federation. Endpoint package + Durable Object.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/activitypub.md) for the full
requirements.

A native [ActivityPub](https://www.w3.org/TR/activitypub/) actor rooted at the
user's **own** domain — making the self-owned presence a first-class fediverse
citizen (followers, replies, boosts) rather than a bridged guest. It mirrors the
architecture proven in [`@dwk/solid-pod`](../solid-pod/README.md): a **stateless
front door** (routing + edge HTTP-signature verification) over a **per-actor
Durable Object** that is the consistency authority for activity-`id` dedup, the
follower/following/outbox collections, and the signed outbound delivery queue.
This is the second `@dwk` package to ship a Durable Object.

## What v1 covers

- **Actor document** (`Person`) served as `application/activity+json`, with the
  public key embedded inline so peers can verify this actor's signatures.
- **Collections** — `outbox`, `followers`, `following` as paged
  `OrderedCollection`s; `inbox` is write-only to peers.
- **Server-to-server (inbound)** `POST /inbox`: HTTP-signature verification at
  the edge, dedup by activity `id`, and handling of `Follow` / `Undo` /
  `Accept` / `Create` / `Update` / `Like` / `Announce` / `Delete`.
- **Server-to-server (outbound)**: auto-`Accept` of follows and signed fan-out
  delivery to follower inboxes, with retry/backoff driven by **DO alarms**.
- **NodeInfo** — the `/.well-known/nodeinfo` discovery document and a
  mostly-static `nodeinfo/2.1` document (live `usage` counts pulled from the DO).
- **Owner publish endpoint** (`POST <actor>/outbox`, bearer-token gated) — the
  publish → `Create` fan-out seam for [`@dwk/micropub`](../micropub/README.md).
  Full client-to-server authoring is **out of scope for v1**. `?skipDelivery=1`
  on `POST <actor>/outbox` or `POST <actor>/publish` inserts the activity into
  the outbox without follower fan-out, and a caller-supplied `published`
  (ISO-8601) is preserved instead of stamped to `now` — the backfill seam for
  syncing pre-existing content (#451).

## Usage

```ts
import { createActivityPub, ActivityPubObject } from "@dwk/activitypub";

const activitypub = createActivityPub({
  baseUrl: "https://example.com",
  actor: { username: "alice", name: "Alice", summary: "Hello, fediverse." },
  publicKeyPem: env.AP_PUBLIC_KEY, // published in the actor document
  privateKeyPem: env.AP_PRIVATE_KEY, // signs outbound deliveries (secret binding)
  publishToken: env.AP_PUBLISH_TOKEN, // optional: enables POST <actor>/outbox
  software: { name: "anglesite", version: "1.2.3" }, // NodeInfo
});

// In your Worker's fetch handler:
//   GET  /users/alice                      → actor document
//   GET  /users/alice/{outbox,followers,following}[?page=N]
//   POST /users/alice/inbox                → signed S2S delivery
//   GET  /.well-known/nodeinfo, /nodeinfo/2.1
return activitypub(request, env, ctx);

// Bind the Durable Object the package ships:
export { ActivityPubObject };
```

```jsonc
// wrangler.jsonc — the binding the package declares
{
  "durable_objects": {
    "bindings": [{ "name": "ACTOR", "class_name": "ActivityPubObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ActivityPubObject"] }],
}
```

The actor IRI and every collection IRI are derived from `baseUrl` + `username`
(`https://example.com/users/alice`, `…/inbox`, `…#main-key`). Mount the package
under a path prefix by including it in `baseUrl` (e.g.
`https://example.com/ap`) — the handler routes purely on the request URL.

## Bindings (declared `Env` fragment)

- `ACTOR` — the Durable Object namespace for the per-actor class
  (`ActivityPubObject`). The single authoritative store for dedup, collections,
  and the delivery queue. The handler **fails loudly** at startup if it is
  missing.

No KV is used for any authoritative state, per
[`spec/non-functional-requirements.md`](../../spec/non-functional-requirements.md):
follower lists, dedup, and the delivery queue all live in the DO's SQLite.

## HTTP signatures

Inbound `POST /inbox` deliveries are authenticated, and outbound deliveries are
signed, with the de-facto fediverse `draft-cavage-http-signatures` profile
(RSA-SHA256 over a covered header set, body integrity via `Digest`). The
implementation is RSA-only with an explicit algorithm allow-list (no `none`, no
symmetric algorithms), mirroring the [`@dwk/dpop`](../dpop/README.md) hardening
posture.

Signing/verification sit behind the `verifyInboxSignature` config seam, so the
forthcoming cross-standard `@dwk/http-signatures` package (RFC 9421 +
draft-cavage; [#59](https://github.com/davidwkeith/workers/issues/59)) can be
swapped in unchanged once it lands.

## Delivery safety

Outbound deliveries target attacker-influenced URLs (a follower's advertised
inbox), so every target passes a syntactic SSRF guard before any request leaves:
HTTPS only, and private / loopback / link-local / cloud-metadata hosts are
refused. (DNS rebinding is out of scope — the Workers runtime does not expose
name resolution to user code; same limitation as
[`@dwk/webmention`](../webmention/README.md)'s safe-fetch.) A `4xx` from a peer
is a permanent failure (dropped); `5xx`, `408`, `429`, and network errors are
retried with exponential backoff up to `deliveryMaxAttempts`.

## Design

The front door is **stateless** and serves the static actor + NodeInfo documents
directly; everything that touches authoritative state is routed to the per-actor
Durable Object. Per the composition contract, the actor profile, key material,
and delivery policy are all passed into `createActivityPub` — nothing is read
from the global environment — so an actor can be instantiated multiple times and
tested in isolation.

ActivityStreams 2.0 documents are emitted in the **compact** JSON-LD form the
fediverse interoperates over (Mastodon et al.), with the AS2 + security
`@context`. Full RDF content-negotiation via [`@dwk/rdf`](../rdf/README.md) is a
future enhancement (its v1 JSON-LD subset and the AS2 context are tracked in
[`spec/open-questions.md`](../../spec/open-questions.md) §4).

## Observability

Federation events flow through the injected `@dwk/log` `Logger`/`Metrics` seams
(default no-op): `activitypub.signature.{accepted,rejected}`,
`activitypub.inbox.{accepted,duplicate}`,
`activitypub.delivery.{succeeded,failed,blocked}`, and
`activitypub.publish.rejected`. Per the redaction policy, only reason codes,
activity types, and sanitized hosts are recorded — never key material, tokens,
or bodies.
