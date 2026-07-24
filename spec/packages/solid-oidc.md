# `@dwk/solid-oidc`

| | |
|---|---|
| **Type** | endpoint (identity provider) |
| **Ships a DO?** | no (D1-backed authorization codes) |
| **Standard** | [Solid-OIDC](https://solidproject.org/TR/solid-oidc) (OpenID Connect + DPoP + WebID) |
| **Status** | first increment implemented (authorization-code + PKCE + DPoP token issuance) |

A **Solid-OIDC OpenID Provider**: a site owner runs their own identity
provider, so the pod (`@dwk/solid-pod`) accepts tokens issued on the owner's
own domain instead of delegating issuance to a third-party provider. This
resolves [`open-questions.md` §1](../open-questions.md) — "when do we own the
OpenID Provider, and is it a separate package or part of `@dwk/indieauth`?" —
toward a **separate package** that **composes `@dwk/oauth`'s primitives**
(the direction `spec/packages/oauth.md` anticipated) rather than growing
inside `@dwk/indieauth`.

## Why it satisfies the pod

`@dwk/solid-pod`'s resource-server validation (`src/auth.ts`/`src/jwt.ts`)
accepts only an **asymmetric issuer-signed JWT** (`ES256`/`ES384`/`RS256`/
`PS256`; never `HS*`) whose claims are: `iss` (= the pod's configured issuer),
a `webid` URL (falling back to `sub`), an `aud` intersecting the pod's set
(default `["solid", <pod origin>]`), `exp`, and `cnf.jkt` — plus a matching
DPoP proof on the request. This OP mints exactly that: an **ES256** access
token, header `{alg, typ:"at+jwt", kid}`, claims `{iss, webid, sub, aud,
client_id, scope, cnf:{jkt}, iat, exp, jti}`, signed by a key whose public
half it publishes at its JWKS. A pod configured to trust this OP's `issuer` +
`jwksUri` therefore accepts its tokens.

## Composition

- `createSolidOidc(config)` — composition-contract handler
  `(request, env, ctx) => Promise<Response>` over the `Env` fragment
  `{ AUTH_DB: D1Database }`. Fails loudly when the binding is missing.
- Config is factory-injected: `issuer`, the ES256 `signingKey` (a private JWK
  secret), the `approveAuthorization` hook, and optional `audience`,
  `scopesSupported`, lifetimes, and `mountPath`.
- **`approveAuthorization` hook** (the IndieAuth pattern): return a
  `{ webid, scope? }` approval to mint a code + redirect, or a `Response` to
  take over (render a login/consent page). Owner authentication and UI stay
  out of the library.
- **Signing key** is a composer-injected secret (`OIDC_SIGNING_KEY`), not read
  from the environment by the package. `generateSigningJwk()` mints a fresh
  P-256 private JWK for provisioning; `importSigningKey()` derives the public
  JWK and a `kid` (the JWK's own, else the RFC 7638 thumbprint).

## Endpoints

Mounted under a **`/oidc` prefix by default** so the `/authorize` + `/token`
paths do not collide with `@dwk/indieauth` when both identity workers compose
onto one origin (the discovery document stays authority-bound at the fixed
well-known path):

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/.well-known/openid-configuration` | GET | OIDC discovery (authority-bound) — extends `@dwk/oauth`'s RFC 8414 metadata with OIDC members + `solid_oidc_supported` + `dpop_signing_alg_values_supported` |
| `/oidc/jwks` | GET | JWK Set — the signing key's **public** half only |
| `/oidc/authorize` | GET | Authorization endpoint — PKCE S256 required; `approveAuthorization` gates consent; mints a single-use code |
| `/oidc/token` | POST | Token endpoint — code → DPoP-bound access token + ID token |

## Flow & security

- **PKCE S256 required** (`plain` rejected); the challenge is captured at
  `/authorize` and verified at `/token`.
- **DPoP required at the token endpoint** (RFC 9449 §5): the proof is verified
  via `@dwk/dpop` and its confirmed `jkt` is bound into the access token as
  `cnf.jkt`. The token response is `token_type: "DPoP"`.
- **Single-use codes**: D1 `solid_oidc_codes`, redeemed by a conditional
  `UPDATE … WHERE used = 0 … RETURNING`, so a replayed code cannot mint a
  second token even under concurrency (strongly consistent — never KV). The
  plaintext code is never stored, only its SHA-256 hash. Expired rows are
  pruned opportunistically.
- **Client/redirect validation first**: a missing/invalid `client_id`
  (must be an absolute URL — a Solid client identifier) or `redirect_uri`
  (absolute http(s)) is a direct `400`, never an open-redirect error sink
  (RFC 6749 §4.1.2.1). The code is bound to its client + redirect and both are
  re-checked at the token endpoint.
- The **ID token** carries `webid`/`sub` and echoes the request `nonce`.

## Deferred (follow-up increments)

- **Client-identifier document validation.** v1 does not yet fetch the
  `client_id` document to confirm the `redirect_uri` is registered there; the
  owner consent hook is the gate. Fetching + validating the client document
  (SSRF-guarded) is the first hardening follow-up.
- **Refresh tokens / `offline_access`.** Advertised in `scopesSupported` but
  no refresh grant is issued yet.
- **Dynamic client registration** (RFC 7591 — `@dwk/oauth` has the building
  block), **PAR** (RFC 9126), and **introspection/revocation** endpoints
  (`@dwk/oauth` factories) are not yet wired.
- **DPoP server nonce** (`use_dpop_nonce` challenge) is not issued.
- **UserInfo endpoint** and richer OIDC claims.

## Conformance

Solid-OIDC / OpenID Connect conformance against a deployed target is the
release bar (tracked in `conformance/status.json`). The colocated tests cover
the crypto (ES256 sign/verify round-trip against the JWKS), the full
authorization-code + PKCE + DPoP flow, single-use code replay, and the
error paths.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers` (D1 `AUTH_DB`); the crypto uses
Web Crypto, available in the same runtime.
