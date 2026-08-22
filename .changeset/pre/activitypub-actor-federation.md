---
"@dwk/activitypub": minor
---

Add `@dwk/activitypub` — a native ActivityPub actor rooted at the user's own
domain. The second `@dwk` package to ship a Durable Object, mirroring the
`@dwk/solid-pod` architecture: a stateless front door over a per-actor DO that
is the consistency authority for dedup, collections, and the delivery queue.

- **`createActivityPub(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler and the package exports the
  `ActivityPubObject` Durable Object class. The actor profile, key material, and
  delivery policy are config-supplied — never read from the global environment —
  and the handler fails loudly when the `ACTOR` Durable Object binding is
  missing.
- **Actor + collections:** the `Person` actor document (public key inline) plus
  `outbox` / `followers` / `following` as paged `OrderedCollection`s; the inbox
  is write-only to peers.
- **Server-to-server federation:** inbound `POST /inbox` with edge HTTP-signature
  verification, activity-`id` dedup, and handling of `Follow` / `Undo` /
  `Accept` / `Create` / `Update` / `Like` / `Announce` / `Delete`; outbound
  auto-`Accept` of follows and signed fan-out delivery to follower inboxes with
  retry/backoff via DO alarms.
- **HTTP Message Signatures** (`draft-cavage`, RSA-SHA256, body integrity via
  `Digest`) are implemented inline against an RSA-only algorithm allow-list and
  sit behind the `verifyInboxSignature` seam, so the forthcoming cross-standard
  `@dwk/http-signatures` package (#59) can be swapped in unchanged.
- **Delivery safety:** every target passes a syntactic SSRF guard (HTTPS only;
  private/loopback/link-local/metadata hosts refused) before any request leaves.
- **NodeInfo** discovery + a mostly-static `nodeinfo/2.1` document (live `usage`
  counts from the DO), and an owner-only, bearer-gated publish endpoint
  (`POST <actor>/outbox`) as the `@dwk/micropub` publish → `Create` fan-out seam.
  Full client-to-server authoring is out of scope for v1.
