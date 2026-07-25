# @dwk/oauth

OAuth 2.0 server building blocks — a cross-standard reusable.

## What this is

Shared OAuth 2.0 server primitives designed for use by authorization servers
(e.g. the eventual Solid-OIDC OP, or alongside IndieAuth). Provides
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
  don't assume D1/DO/KV. The caller (e.g. the eventual Solid-OIDC OP) wires
  the concrete persistence.
- **DPoP integration.** When DPoP is in use, introspection responses include
  `cnf.jkt` and tokens without valid proofs are rejected.
