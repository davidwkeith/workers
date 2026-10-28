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
  `Accept` / `Create` / `Update` / `Like` / `Announce` / `Delete` / `Move`.
  A `Move` from an account this actor follows switches the follow to the
  new account once that account lists the old one in `alsoKnownAs`.
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
- **Blind-addressed restricted delivery** (`bto`/`bcc`, #496) — both publish
  seams accept blind recipients, each delivered to their own inbox with the
  blind addressing stripped (AP §6.1). An activity addressed *only* blindly is
  restricted: no follower fan-out and no public outbox listing. Best-effort,
  honor-system distribution — AS2 addressing is a delivery hint, not access
  control; enforce reads elsewhere if you need actual privacy.

## Usage

```ts
import { createActivityPub, ActivityPubObject } from "@dwk/activitypub";

const activitypub = createActivityPub({
  baseUrl: "https://example.com",
  actor: { username: "alice", name: "Alice", summary: "Hello, fediverse." },
  publicKeyPem: env.AP_PUBLIC_KEY, // published in the actor document
  privateKeyPem: env.AP_PRIVATE_KEY, // signs outbound deliveries (secret binding)
  integrityKey: JSON.parse(env.AP_INTEGRITY_KEY), // optional: Ed25519 JWK for FEP-8b32 proofs (secret binding)
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

## Object integrity proofs (FEP-8b32)

Set `integrityKey` to an Ed25519 private JWK (for example the output of
`crypto.subtle.exportKey("jwk", privateKey)` for a `{ name: "Ed25519" }` key
pair) and the actor:

- publishes the public half as a [FEP-521a](https://codeberg.org/fediverse/fep/src/branch/main/fep/521a/fep-521a.md)
  `assertionMethod` `Multikey` at `<actor>#ed25519-key`, and
- delivers every activity it authors with a top-level
  [FEP-8b32](https://codeberg.org/fediverse/fep/src/branch/main/fep/8b32/fep-8b32.md)
  `DataIntegrityProof` (`eddsa-jcs-2022`), so peers can authenticate it
  without relying on the HTTP signature, for example after it has been
  forwarded.

Store the JWK as a **secret binding** (`wrangler secret put AP_INTEGRITY_KEY`),
never a plain `vars` entry: it is a private signing key, handled exactly like
`privateKeyPem`. It is persisted in the actor's Durable Object so alarm-driven
deliveries can sign.

Activities this actor forwards on someone else's behalf are never signed. The
proof pipeline is [`@dwk/vc/data-integrity`](../vc/README.md)'s. Verifying
proofs on inbound activities is not implemented yet; inbound authentication is
still the HTTP signature.

## Unreachable peers

Each actor's Durable Object keeps a per-host delivery circuit breaker. After 5
consecutive retryable failures to a host, its queued deliveries are deferred
(not attempted, and not charged a retry) for a cooldown that starts at 10
minutes and doubles on each failed probe, up to 24 hours. A successful
delivery, or any signed activity received from that host, closes the circuit.
A host that has been failing for 7 days has its deliveries dropped while the
circuit is open, the same window Mastodon uses before it marks a domain
unavailable. This keeps one dead peer from spending every alarm wake on
10-second timeouts.

## HTTP signatures

Inbound `POST /inbox` deliveries are verified against either the de-facto
fediverse `draft-cavage-http-signatures` profile (RSA-SHA256 over a covered
header set, body integrity via `Digest`) or
[RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures
(via [`@dwk/http-signatures`](../http-signatures/README.md)). The
implementation is RSA-only with an explicit algorithm allow-list (no `none`, no
symmetric algorithms), mirroring the [`@dwk/dpop`](../dpop/README.md) hardening
posture.

Outbound deliveries **double-knock**: each is signed with RFC 9421 first, and
if the peer answers `400`/`401`/`403` the same body is re-signed with
draft-cavage and sent once more. A host that only accepts draft-cavage is
remembered in the actor's Durable Object for 7 days, so later deliveries skip
the first knock (the same strategy [Fedify](https://fedify.dev/manual/send#double-knocking-http-signatures)
uses). Outbound `GET`s (authorized-fetch key resolution) stay draft-cavage.

Every outbound request (key resolution, delivery, discovery) sends a
descriptive `User-Agent` (`userAgent` in `ActivityPubConfig`, defaulting to
`DEFAULT_USER_AGENT`; override it to identify a specific deployment), since
some peers — and the anti-scraper challenge layers (e.g.
[Anubis](https://github.com/TecharoHQ/anubis/issues/31)) a growing number of
hosts run in front of federated software — treat an unidentified client as a
bot. If signature verification against a specific peer consistently fails
with `key_unresolved` despite the target being reachable from elsewhere (e.g.
`curl`), the default key resolver's log line says why: it records the actual
failure (`activitypub.key_resolution.failed`: `reason`, `host`, and `status`
when available) rather than only the generic `key_unresolved`
signature-rejection reason. Causes seen in practice:

- A challenge page served to the actor-document fetch by a bot-protection
  layer in front of the peer. The `User-Agent` is the fix.
- A `401` from a peer in Mastodon's authorized-fetch ("secure") mode, which
  refuses unsigned actor fetches. Outbound `GET`s are signed as the actor
  (`(request-target) host date`) when `privateKeyPem` is configured, so set it.
- On Cloudflare, a peer whose hostname is in the Worker's **own zone** (a
  Mastodon instance on a subdomain of the site, say). A same-zone subrequest
  goes through Cloudflare's proxy with the zone's SSL/TLS encryption mode, even
  for a DNS-only record, so under **Flexible** the origin's HTTP→HTTPS redirect
  loops back to the same URL (`too_many_redirects`). The fix is **Full
  (strict)** on the zone; no `User-Agent` changes it
  ([dwk.io#62](https://github.com/davidwkeith/dwk.io/pull/62)).

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
