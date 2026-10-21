---
"@dwk/micropub": minor
"@dwk/microsub": minor
---

Add `acceptBearerTokens` (default `false`): accept the unbound Bearer tokens `@dwk/indieauth` issues under its opt-in `bearerTokens` policy, so clients that predate DPoP can authenticate. An unbound token is accepted only under the `Bearer` scheme (or Micropub's `access_token` body parameter), never under `DPoP`, and goes through the same subject, revocation, and scope checks. A DPoP-bound token still requires its matching proof either way.
