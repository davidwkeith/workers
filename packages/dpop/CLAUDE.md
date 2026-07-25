# @dwk/dpop

DPoP (RFC 9449) proof verification — a cross-standard reusable library.

## What this is

Pure-function library that verifies DPoP proof JWTs. Takes plain-data inputs
(proof string, HTTP method, URL, optional access token) and returns a typed
result. No Workers runtime dependency. Used by `@dwk/indieauth` (token
issuance) and `@dwk/solid-pod` (resource-server token validation).

## Spec

`spec/packages/dpop.md` — authoritative requirements.

## Key constraints

- **Protocol-agnostic.** Must stay free of IndieWeb/Solid assumptions so future
  `@dwk` standards adopt it unchanged. This is a hard constraint, not a preference.
- **No Cloudflare imports.** Pure WebCrypto + standard APIs only.
- **No dependencies.** Zero runtime deps — keep it that way.
- **Caller owns replay policy.** This library extracts `jti` but does not store
  or deduplicate it; callers (indieauth, solid-pod) manage their own
  strongly-consistent JTI stores.
