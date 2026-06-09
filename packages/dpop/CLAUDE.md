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

## Test environment

Node (`environment: "node"` in vitest.config.ts). No Miniflare setup needed.

```bash
pnpm test --project @dwk/dpop           # run all tests
pnpm test --project @dwk/dpop -t "name" # single test by name
pnpm --filter @dwk/dpop typecheck       # typecheck only
```

## File layout

```
src/index.ts       # public surface: verifyDpopProof + types
src/*.test.ts      # colocated tests
```

## Exports

- `verifyDpopProof(input: DpopVerifyInput): Promise<DpopVerifyResult>` — the
  single entry point. Validates: typ, alg, jwk presence/validity, RSA key size,
  crv match, signature, htm/htu binding, iat freshness, optional nonce/ath/jkt.
- `DpopFailureReason` — exhaustive union of 23 failure reasons.
- `DEFAULT_MAX_AGE_SECONDS` — 300s default proof window.

## Depended on by

`@dwk/indieauth`, `@dwk/micropub`, `@dwk/microsub`, `@dwk/oauth`, `@dwk/solid-pod`
