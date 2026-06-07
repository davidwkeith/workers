# `@dwk/indieauth`

> IndieAuth authorization, token, and metadata endpoints with PKCE and DPoP-bound tokens.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/indieauth.md) for the full requirements.

The identity layer rooted at the user's own domain. It runs the
authorization-code + PKCE flow, issues **DPoP-bound** access tokens (bound via
[`@dwk/dpop`](../dpop)'s `cnf.jkt`), and publishes an OAuth 2.0 / IndieAuth
server-metadata document so clients can discover the endpoints and PKCE methods.
The tokens it mints are consumed downstream by [`@dwk/micropub`](../micropub)
and validated by the Solid Pod Resource Server.

## Endpoints

| Endpoint               | Default path                               | Purpose                                              |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Metadata               | `/.well-known/oauth-authorization-server`  | Discovery: issuer, endpoints, `S256`, DPoP algs.     |
| Authorization (`GET`)  | `/authorize`                               | Validate request, authenticate/consent, issue code.  |
| Authorization (`POST`) | `/authorize`                               | Profile-URL exchange (identity only, no token).      |
| Token (`POST`)         | `/token`                                   | Redeem code → DPoP-bound access token.               |
| Revocation (`POST`)    | `/revocation`                              | Revoke an issued token (RFC 7009).                   |

Every endpoint path is derived from `baseUrl` but can be overridden with an
absolute URL, and routing matches on pathname — so the handler is mountable
under any prefix.

## Usage

```ts
import { createIndieAuth } from "@dwk/indieauth";

const indieauth = createIndieAuth({
  baseUrl: "https://example.com",
  scopesSupported: ["create", "update", "media"],
  // The library owns all protocol mechanics; you own authentication + consent.
  async approveAuthorization(req) {
    const user = await authenticateCurrentUser(req); // your concern
    if (!user) return new Response("login", { status: 401 }); // take over
    return { me: user.profileUrl, scopes: req.scopes, profile: user.profile };
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return indieauth(request, env, ctx);
  },
};
```

`approveAuthorization` returns either an approval (`{ me, scopes?, profile? }`)
to mint a code and redirect, or a `Response` to take over the exchange (render a
login/consent page, redirect to an external IdP, etc.).

### Audience-restricted tokens (RFC 8707 / RFC 9700 §2.3)

When a client supplies one or more [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)
`resource` parameters on the authorization (and, to narrow, the token) request,
the issued token is **audience-restricted**: it carries an `aud` claim naming the
resource server(s) it may be presented to, so a token leaked to one resource
server cannot be replayed at another. Each requested `resource` must be a
well-formed absolute URI and pass the optional `resourceIndicatorPolicy`
(defaults to accepting any well-formed resource); an unacceptable value is
rejected with `invalid_target`. Resource servers complete the restriction by
passing their own identifier as the expected `audience` on verify (below).

### Bindings

Declared as a TypeScript `Env` fragment; the handler **fails loudly** if either
is missing:

- `AUTH_DB` — a **D1** database holding authorization codes and issued-token
  records. Authorization state is strongly consistent (never KV); single-use
  redemption is enforced with a conditional `UPDATE ... RETURNING`.
- `TOKEN_SIGNING_KEY` — secret signing-key material for the HS256 access tokens.

### Validating tokens (Resource Server)

```ts
import { verifyAccessToken } from "@dwk/indieauth";
import { verifyDpopProof } from "@dwk/dpop";

const result = await verifyAccessToken(token, env.TOKEN_SIGNING_KEY, {
  issuer: "https://example.com",
  // Optional: when set, the token MUST carry an `aud` (RFC 8707) including this
  // resource server's identifier, else it fails with `audience_mismatch`.
  audience: "https://media.example.com/",
});
if (result.valid) {
  const dpop = await verifyDpopProof({
    proof: request.headers.get("DPoP")!,
    htm: request.method,
    htu: request.url,
    accessToken: token,
    expectedJkt: result.claims.cnf.jkt, // completes the DPoP binding
  });
}
```

## License

[ISC](../../LICENSE)
