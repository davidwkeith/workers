# @dwk/solid-oidc

A [Solid-OIDC](https://solidproject.org/TR/solid-oidc) OpenID Provider for
Cloudflare Workers: run your own identity provider so your Solid pod accepts
tokens issued on your own domain.

Issues **DPoP-bound, ES256-signed access tokens** carrying a `webid` claim
(plus OIDC ID tokens) through an authorization-code + PKCE (S256) flow. The
access-token claim set is exactly what `@dwk/solid-pod` validates (`iss`,
`webid`, `aud`, `cnf.jkt`, `typ: at+jwt`), so a pod configured to trust this
OP's JWKS accepts its tokens.

## Usage

```ts
import { createSolidOidc, generateSigningJwk } from "@dwk/solid-oidc";

// Provision once; persist as the OIDC_SIGNING_KEY secret.
const signingKey = await generateSigningJwk();

const handler = createSolidOidc({
  issuer: "https://id.example",
  signingKey, // a private ES256 JWK (injected secret)
  mountPath: "/oidc", // coexist with @dwk/indieauth on one origin
  audience: ["solid", "https://alice.example"],
  // Owner authentication + consent (the IndieAuth pattern):
  approveAuthorization: async (req, httpRequest) => {
    // ...render a login/consent page (return a Response), or:
    return { webid: "https://alice.example/profile#me" };
  },
});

export default {
  fetch: (request, env, ctx) => handler(request, env, ctx),
};
```

## Endpoints (under `mountPath`, default `/oidc`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/.well-known/openid-configuration` | GET | OIDC discovery (authority-bound, not prefixed) |
| `/oidc/jwks` | GET | JWK Set (public key only) |
| `/oidc/authorize` | GET | Authorization endpoint (PKCE S256 required) |
| `/oidc/token` | POST | Token endpoint (DPoP required; code → tokens) |

## Bindings (`Env` fragment)

| Binding | Type | Purpose |
| --- | --- | --- |
| `AUTH_DB` | D1 | Single-use authorization codes (`solid_oidc_codes`) |

The ES256 signing key is passed through config (`signingKey`), sourced from a
composer-injected secret — never read from the environment by the package.

## Security

- PKCE **S256 required** (`plain` rejected).
- **DPoP required** at the token endpoint (RFC 9449); its `jkt` is bound into
  the token as `cnf.jkt`.
- **Single-use codes** via a conditional `UPDATE … RETURNING` (D1, strongly
  consistent); codes are stored SHA-256-hashed, never in plaintext.
- Client/redirect validated before any redirect (no open-redirect error sink).

## Scope / deferred

First increment. Not yet implemented (see `spec/packages/solid-oidc.md`):
client-identifier document validation, refresh tokens, dynamic client
registration / PAR / introspection wiring (building blocks in `@dwk/oauth`),
DPoP server nonce, and a UserInfo endpoint.

## License

ISC
