# Architecture

## Monorepo

A single repository managed with **pnpm workspaces**. Endpoint packages are
kept **thin**; shared logic lives in library packages so the composed Worker
bundle stays inside the platform limits (see
[non-functional-requirements.md](non-functional-requirements.md#runtime-budget)).

## Package taxonomy

| Package | Type | Responsibility |
|---|---|---|
| `@dwk/indieauth` | endpoint | IndieAuth authorization + token + metadata endpoints; PKCE; profile-URL verification; scope issuance. |
| `@dwk/micropub` | endpoint | Micropub create/update/delete; JSON + form-encoded; media endpoint (R2); `q=config` / `q=source`. Consumes IndieAuth tokens. |
| `@dwk/microsub` | endpoint | Microsub server: channel/subscription management, queue-driven feed polling (Atom/RSS/JSON Feed/h-feed), JF2 timelines for reader clients. |
| `@dwk/webmention` | endpoint | Webmention receiver (async verification queue) + sender (on publish); inbox store. |
| `@dwk/websub` | endpoint | WebSub (W3C) hub: D1 subscription store with lease expiry, intent-verification callbacks, HMAC-signed content distribution via queue. |
| `@dwk/webfinger` | endpoint | WebFinger (RFC 7033) endpoint: resource resolution to JRD with rel filtering. |
| `@dwk/host-meta` | endpoint | Web Host Metadata (RFC 6415): `/.well-known/host-meta` XRD + JRD documents. |
| `@dwk/webauthn` | endpoint + DO | WebAuthn Relying Party: registration/authentication ceremonies; per-RP **Durable Object** holds challenge + credential state. |
| `@dwk/vc` | endpoint | Verifiable Credentials (VCDM 2.0) issuance/verification with Data Integrity proofs; did:web; Bitstring Status List revocation (D1). |
| `@dwk/activitypub` | endpoint + DO | ActivityPub actor: inbox/outbox federation, HTTP signature verification, alarm-driven delivery retries; per-actor **Durable Object**. |
| `@dwk/remotestorage` | endpoint + DO | remoteStorage protocol server; per-account **Durable Object** over R2 blob bodies. |
| `@dwk/solid-pod` | endpoint + DO | Edge Solid Pod: LDP verbs, content negotiation, N3 Patch, WAC, notifications, WebDAV mount. Exports the per-pod **Durable Object** class. |
| `@dwk/atproto-pds` | endpoint + DO | AT Protocol PDS: MST/DAG-CBOR/CAR repository, did:web identity, firehose; per-account **Durable Object**. Strategic outlier — shares neither `@dwk/store` nor `@dwk/rdf`. |
| `@dwk/webdav` | endpoint | WebDAV (RFC 4918) Class 2 façade over an injected `WebdavBackend` seam; scoped app-password auth; lock + credential DO-SQLite stores. |
| `@dwk/wac` | lib | Web Access Control evaluation (effective-ACL walk, Append vs Write). Used by `solid-pod`. |
| `@dwk/dpop` | lib | DPoP proof verification. Shared by `indieauth` token validation and `solid-pod` Resource Server. |
| `@dwk/rdf` | lib | Thin Turtle/JSON-LD parse + serialize over N3.js; triple ↔ store helpers. Edge-budget-conscious. |
| `@dwk/log` | lib | Injectable structured-logging seam (`Logger` + `Metrics` interfaces, no-op/console/Analytics Engine adapters). Cross-standard reusable; protocol-agnostic. |
| `@dwk/ldn` | lib | RDF-only Linked Data Notifications primitives (inbox discovery, notification validation, listing) shared by `solid-pod` and `activitypub`. |
| `@dwk/http-signatures` | lib | HTTP message signatures (RFC 9421 + draft-cavage), sign and verify. Protocol-agnostic. |
| `@dwk/oauth` | lib | OAuth building blocks (RFC 8414/7662/7009/9126/7591). Protocol-agnostic. |
| `@dwk/calendar` | lib | Canonical JSCalendar (RFC 8984)-shaped event model + RFC 5545 iCalendar / JSCalendar serializers; per-standard adapters live in the endpoint packages. |
| `@dwk/store` | lib | Encapsulates the DO-SQLite quad store + R2 copy-on-write blob bodies behind one interface — `createStore` runs against an injected `DurableObjectState` _inside_ the consuming package's DO (`solid-pod`, `remotestorage`) — keeping endpoint packages storage-agnostic and unit-testable. |
| `@dwk/server` | host (private) | Node/Express self-hosting host with Workers-API shims. Never published to npm; ships only as a Docker image. |

## Mental model

```
        ┌────────────────────────────────────────────────────────┐
client ─▶│  stateless Worker front door  (routing, edge auth)      │
        └───────────────┬───────────────────────┬─────────────────┘
                        │                        │
            IndieWeb trio │                       │ solid-pod
        (stateless handlers)            ┌─────────▼─────────────┐
                        │               │  per-pod Durable Obj  │  ← consistency,
                ┌───────▼───────┐       │  (SQLite quad store)  │    authz, notifications
                │   D1  /  R2   │       └─────────┬─────────────┘
                └───────────────┘                 │
                                          ┌────────▼────────┐
                                          │  R2 blob bodies │
                                          └─────────────────┘
```

- The **Worker front door** is stateless: it routes, validates tokens at the
  edge, and forwards writes to the authoritative store.
- The **per-pod Durable Object** is the single-threaded consistency, authz, and
  notification authority for a Solid Pod. The same pattern repeats across the
  packages that ship a DO: `@dwk/solid-pod` (per-pod), `@dwk/activitypub`
  (per-actor), `@dwk/remotestorage` (per-account), `@dwk/webauthn` (per-RP),
  and `@dwk/atproto-pds` (per-account repository). `@dwk/store` ships no DO of
  its own — it is the storage library instantiated _inside_ a consuming
  package's DO (`solid-pod`, `remotestorage`) against the object's injected
  SQLite + R2 bindings; its only DO class is the test harness.
- **R2** holds blob bodies (oversized or binary resources, media uploads).
- The **IndieWeb trio** (`indieauth`, `micropub`, `webmention`) is stateless
  handlers backed by D1 and/or R2 — no Durable Object.

## Naming convention

This matters because `@dwk` will grow to cover more standards.

- **Endpoint packages** are named for the standard they implement
  (`@dwk/micropub`, `@dwk/solid-pod`).
- **Primitives** are two kinds:
  - **Cross-standard reusables** that future `@dwk` packages should share
    (`@dwk/rdf`, `@dwk/dpop`, `@dwk/log`). These MUST stay free of IndieWeb/Solid
    assumptions so the next standard can adopt them unchanged.
  - **Standard-specific helpers** (`@dwk/wac`) — tied to one standard by design.

Keeping the reusable primitives protocol-agnostic is a hard design constraint,
not a preference: it is what lets the scope expand without rework.
