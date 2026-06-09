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

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:
- D1: `AUTH_DB`
- Bindings: `TOKEN_SIGNING_KEY` (test key)

```bash
pnpm test --project @dwk/indieauth
```

## File layout

```
src/index.ts       # public surface: createIndieAuth, verifyAccessToken, signAccessToken, types
src/config.ts      # IndieAuthConfig type and Env fragment
src/handler.ts     # createIndieAuth factory (authorization + token + metadata routes)
src/token.ts       # JWT signing/verification, access token hash
src/store.ts       # createIndieAuthStore (D1-backed code + token persistence)
src/pkce.ts        # PKCE challenge verification
src/auth.ts        # profile URL canonicalization, rel=me verification
src/metadata.ts    # RFC 8414 server metadata builder
src/*.test.ts      # colocated tests
```

## Dependencies

- `@dwk/dpop` — DPoP proof verification.
- `@dwk/log` — structured logging.

## Depended on by

`@dwk/micropub`, `@dwk/microsub`
