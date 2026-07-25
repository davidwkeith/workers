# @dwk/indieauth

IndieAuth authorization/token/metadata endpoints.

## What this is

Identity layer for the IndieWeb stack. Issues access tokens consumed by Micropub,
Microsub, and other IndieWeb clients. Implements the authorization endpoint
(PKCE-required), token endpoint (issuance + refresh + revocation), and metadata
endpoint (RFC 8414). Supports `rel=me` profile-URL verification, DPoP-bound
tokens, and audience restriction via RFC 8707 resource indicators.

## Spec

`spec/packages/indieauth.md` — authoritative requirements.

## Key constraints

- **PKCE mandatory.** Every authorization request must include `code_challenge`;
  plain codes are rejected.
- **DPoP-bound tokens.** Access tokens include a `cnf.jkt` claim binding them to
  the client's DPoP key. The token endpoint verifies DPoP proofs on issuance; the
  resource server (micropub, microsub) verifies on every request.
- **D1 for auth state.** Authorization codes and issued tokens live in D1
  (`AUTH_DB`). Codes are single-use with short TTL.
- **Token signing key.** `TOKEN_SIGNING_KEY` secret binding is required. Fail
  loudly at startup if missing.
- **Profile URL verification.** `rel=me` link-back verification ensures the
  authenticated user controls the claimed profile URL.
