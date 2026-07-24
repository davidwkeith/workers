# @dwk/solid-oidc

Solid-OIDC OpenID Provider — an endpoint package.

## What this is

Issues DPoP-bound, ES256-signed WebID access tokens (plus OIDC ID tokens)
through an authorization-code + PKCE (S256) flow, so a Solid pod on the
owner's domain accepts tokens from a provider the owner runs. Resolves
`spec/open-questions.md` §1 toward a separate package composing `@dwk/oauth`.

## Spec

`spec/packages/solid-oidc.md` — authoritative requirements.

## Key constraints

- **Tokens must satisfy `@dwk/solid-pod`.** The access-token claim set
  (`iss`, `webid`, `aud` ⊇ the pod's set, `cnf.jkt`, header `typ: at+jwt`,
  ES256) is dictated by what the pod's `auth.ts`/`jwt.ts` validate. Do not
  change the claim shape without checking that contract.
- **Asymmetric signing only.** Pods reject `HS*`; sign ES256 and publish the
  public half at JWKS. The signing key is a composer-injected secret, never
  read from the environment by the package.
- **PKCE S256 required; DPoP required at the token endpoint.** The DPoP
  proof's `jkt` (from `@dwk/dpop`'s `verifyDpopProof`) is bound as `cnf.jkt`.
- **Single-use codes.** D1 `solid_oidc_codes`, redeemed via a conditional
  `UPDATE … WHERE used = 0 … RETURNING` (strongly consistent — never KV);
  stored SHA-256-hashed, never in plaintext.
- **No login UI.** Owner auth/consent is the injected `approveAuthorization`
  hook (the IndieAuth pattern).
- **Mounts under a prefix** (`/oidc` by default) so `/authorize` + `/token`
  don't collide with `@dwk/indieauth`; discovery stays authority-bound at
  `/.well-known/openid-configuration`.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers` (D1 `AUTH_DB`); Web Crypto for
ES256/DPoP.

```bash
pnpm test --project @dwk/solid-oidc
```

## File layout

```
src/index.ts          # public surface: createSolidOidc + types
src/config.ts         # SolidOidcConfig, Env fragment, resolveConfig
src/handler.ts        # createSolidOidc router (discovery/jwks/authorize/token)
src/authorize.ts      # GET /authorize (PKCE capture + approval hook → code)
src/token-endpoint.ts # POST /token (code + DPoP → access + id tokens)
src/discovery.ts      # OIDC discovery doc (over @dwk/oauth) + JWKS
src/jws.ts            # ES256 compact-JWS signer + public-JWK derivation
src/token.ts          # access-token / id-token claim minters
src/pkce.ts           # PKCE S256 verify
src/store.ts          # D1 authorization-code store (single-use)
src/encoding.ts       # base64url / hashing helpers
src/*.test.ts         # colocated tests
```

## Dependencies

- `@dwk/oauth` — RFC 8414 metadata builder (discovery), and the introspection/
  revocation/PAR/DCR building blocks for later increments.
- `@dwk/dpop` — DPoP proof verification (+ the bound `jkt`).
- `@dwk/log` — structured logging interface.

## Depended on by

None yet. Composes alongside `@dwk/solid-pod` (the RS that accepts its tokens)
and `@dwk/indieauth` (a sibling identity endpoint) in a Worker.
