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
| `@dwk/webmention` | endpoint | Webmention receiver (async verification queue) + sender (on publish); inbox store. |
| `@dwk/solid-pod` | endpoint + DO | Edge Solid Pod: LDP verbs, content negotiation, N3 Patch, WAC, notifications. Exports the per-pod **Durable Object** class. |
| `@dwk/wac` | lib | Web Access Control evaluation (effective-ACL walk, Append vs Write). Used by `solid-pod`. |
| `@dwk/dpop` | lib | DPoP proof verification. Shared by `indieauth` token validation and `solid-pod` Resource Server. |
| `@dwk/rdf` | lib | Thin Turtle/JSON-LD parse + serialize over N3.js; triple ↔ store helpers. Edge-budget-conscious. |
| `@dwk/store` | lib | Encapsulates the DO-SQLite quad store + R2 copy-on-write blob bodies behind one interface, keeping endpoint packages storage-agnostic and unit-testable. |

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
  notification authority for a Solid Pod. `solid-pod` is the **only** package
  that ships a DO.
- **R2** holds blob bodies (oversized or binary resources, media uploads).
- The **IndieWeb trio** (`indieauth`, `micropub`, `webmention`) is stateless
  handlers backed by D1 and/or R2 — no Durable Object.

## Naming convention

This matters because `@dwk` will grow to cover more standards.

- **Endpoint packages** are named for the standard they implement
  (`@dwk/micropub`, `@dwk/solid-pod`).
- **Primitives** are two kinds:
  - **Cross-standard reusables** that future `@dwk` packages should share
    (`@dwk/rdf`, `@dwk/dpop`). These MUST stay free of IndieWeb/Solid
    assumptions so the next standard can adopt them unchanged.
  - **Standard-specific helpers** (`@dwk/wac`) — tied to one standard by design.

Keeping the reusable primitives protocol-agnostic is a hard design constraint,
not a preference: it is what lets the scope expand without rework.
