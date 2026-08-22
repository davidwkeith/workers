---
"@dwk/solid-pod": patch
---

Close three access-token JWT validation gaps in `@dwk/solid-pod` (#35):

- **Enforce `typ: at+jwt`.** The Resource Server now requires the access-token
  header `typ` to be `at+jwt` (case-insensitive, tolerating the
  `application/at+jwt` media-type form), so an ID token or other issuer-signed
  JWT sharing the same `iss`/`aud`/`webid` cannot be replayed as an access token
  (token-type confusion). Configurable via the new `accessTokenType` option; set
  to `null` to opt out for issuers that omit `typ`.
- **Pin `kid`.** When a token names a `kid` that matches no JWKS key,
  `verifyJwtSignature` now fails instead of falling back to other
  alg-compatible keys, restoring `kid` pinning. Tokens with no `kid` still try
  every compatible key.
- **Validate `nbf`.** A token presented before its `nbf` not-before time is now
  rejected (`token_not_yet_valid`).
