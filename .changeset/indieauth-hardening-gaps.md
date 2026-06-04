---
"@dwk/indieauth": patch
---

Close four authorization-endpoint hardening gaps in `@dwk/indieauth` (issue
#41):

- **Granted scopes are now constrained to `scopesSupported`.** When the server
  advertises a non-empty `scopes_supported`, `issueCode` intersects the scopes
  from the approval hook (or request) against it, so neither a hook nor a client
  can have the server issue a scope it claims not to support — an over-broad
  scope here is a privilege concern because `@dwk/micropub` consumes these
  scopes for authz. An empty `scopesSupported` still means "no advertised
  constraint" and passes scopes through unchanged.
- **The approved `me` is canonicalized.** `issueCode` now runs `approval.me`
  through `canonicalizeProfileUrl` and rejects the exchange (redirecting with
  `error=server_error`) when it does not yield a valid IndieAuth profile URL,
  rather than persisting/echoing the hook's value verbatim.
- **DPoP `htu` is bound to the advertised token endpoint.** The token endpoint
  now verifies the proof against `config.tokenEndpoint` instead of
  `request.url`, so a path-rewriting proxy or differing public origin no longer
  mismatches the client's view of `token_endpoint` from the metadata document.
- **`http:` `client_id`/`redirect_uri` are restricted to loopback hosts.**
  `isHttpUrl` now accepts plain `http` only for the loopback IPs (`127.0.0.1`,
  `[::1]`) for local development; every other client must use `https`, per the
  IndieAuth/OAuth native-app guidance.
