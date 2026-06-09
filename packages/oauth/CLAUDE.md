# @dwk/oauth

OAuth 2.0 server building blocks — a cross-standard reusable.

## What this is

Shared OAuth 2.0 server primitives for Solid-OIDC OP and IndieAuth. Provides
handler factories for token introspection (RFC 7662), token revocation
(RFC 7009), Pushed Authorization Requests (RFC 9126), and dynamic client
registration (RFC 7591). Also generates RFC 8414 authorization server metadata.
Reuses `@dwk/dpop` for DPoP-bound token support.

## Spec

`spec/packages/oauth.md` — authoritative requirements.

## Key constraints

- **Protocol-agnostic.** Building blocks for any OAuth 2.0 authorization server.
  Must not import IndieWeb or Solid specifics.
- **No Cloudflare imports.** Pure-data library, tests under Node.
- **Caller-provided storage.** Handler factories accept store interfaces; they
  don't assume D1/DO/KV. The caller (indieauth, eventual Solid-OIDC OP) wires
  the concrete persistence.
- **DPoP integration.** When DPoP is in use, introspection responses include
  `cnf.jkt` and tokens without valid proofs are rejected.

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/oauth
```

## File layout

```
src/index.ts          # public surface: all handler factories, metadata builder, error types
src/metadata.ts       # RFC 8414 AS metadata builder
src/introspection.ts  # RFC 7662 introspection handler
src/revocation.ts     # RFC 7009 revocation handler
src/par.ts            # RFC 9126 PAR handler
src/registration.ts   # RFC 7591 DCR handler
src/*.test.ts         # colocated tests
```

## Dependencies

- `@dwk/dpop` — DPoP proof verification for bound tokens.
- `@dwk/log` — structured logging interface.

## Depended on by

`@dwk/remotestorage` (for bearer token authentication)
