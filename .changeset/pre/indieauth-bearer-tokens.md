---
"@dwk/indieauth": major
---

Add an opt-in `bearerTokens` policy for IndieWeb clients that predate DPoP. When it's set and a token request carries no `DPoP` header, the token endpoint issues an unbound RFC 6750 Bearer token (`token_type: "Bearer"`, no `cnf` claim), narrowed to `bearerTokens.scopes` (default `scopesSupported`; none left is `invalid_scope`) and living `bearerTokens.lifetimeSeconds` (default, and capped at, `accessTokenLifetimeSeconds`). It is recorded in the token store with an empty `jkt`, so revocation applies. A request that sends a proof is always held to it; an invalid proof is never downgraded. Off by default, so existing deployments are unchanged.

Breaking (types): `AccessTokenClaims.cnf` and `MintAccessTokenInput.jkt` are now optional, and `verifyAccessToken` accepts a token without `cnf`. Resource servers that read `claims.cnf.jkt` must now handle its absence, and reject an unbound token unless they mean to accept Bearer tokens (`@dwk/mcp` already does).
