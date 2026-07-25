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
