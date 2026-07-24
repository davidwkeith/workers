# `@dwk/dpop`

> DPoP (RFC 9449) proof verification. Cross-standard reusable.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/dpop.md) for the full requirements.

This package is **cross-standard reusable**: it takes plain-data inputs only,
has no Workers-runtime dependency (only Web Crypto), and unit-tests in isolation
(Node, no `workerd`). It is **protocol-agnostic** — it knows nothing about
IndieAuth or Solid. The caller supplies the request facts and any access-token
binding it expects, and owns replay detection via the returned `jti`.

## API

```ts
import { verifyDpopProof } from "@dwk/dpop";

const result = await verifyDpopProof({
  proof: request.headers.get("DPoP")!, // the DPoP proof JWT
  htm: request.method, // HTTP method, e.g. "POST"
  htu: "https://pod.example/resource", // request URI (query/fragment ignored)
  // now,            // epoch seconds; defaults to Date.now()
  // maxAgeSeconds,  // iat clock-skew window; defaults to 300
});

if (!result.valid) {
  // result.reason is a stable code, e.g. "htu_mismatch", "signature_invalid"
  return new Response("invalid DPoP proof", { status: 401 });
}

// Enforce your own replay policy with the verified jti.
if (await seenBefore(result.jti)) return new Response("DPoP replay", { status: 401 });
```

### Resource Server: token binding

When a request carries a DPoP-bound access token, pass the token and the token's
`cnf.jkt` to verify the binding:

```ts
const result = await verifyDpopProof({
  proof,
  htm,
  htu,
  accessToken, // proof MUST carry ath = base64url(SHA-256(accessToken))
  expectedJkt, // proof key thumbprint MUST equal this
});
```

A Resource Server enforcing `ath` MUST pass `expectedJkt` too: `ath` only proves
the proof was made for this token, while `cnf.jkt` proves the proof key is the
one the token was issued to. Supplying `accessToken` without `expectedJkt` is
rejected with `jkt_required` rather than validating an unbound proof
(RFC 9449 §7.1).

## What is verified

- **Header** — `typ` is exactly `dpop+jwt`; no `crit` parameter is present
  (RFC 7515 §4.1.11); `alg` is an asymmetric algorithm from the allow-list
  (`ES256`, `ES384`, `ES512`, `EdDSA`, `RS256`, `PS256` — never `none` or
  HMAC); `jwk` is present, carries no private key material, has an EC/OKP
  `crv` matching the `alg` (`EdDSA` is Ed25519 only — the Workers runtime has
  no Ed448 Web Crypto support), and (for RSA) a modulus of at least 2048 bits.
- **Signature** — over `header.payload` using the embedded `jwk`.
- **Claims** — `htm` matches the request method (case-insensitive); `htu`
  matches the request URI after normalization (scheme/host lowercased, default
  port and any query/fragment removed); `iat` is within the clock-skew window;
  `jti` is a present, non-empty string.
- **Bindings** (optional) — `ath` matches `base64url(SHA-256(accessToken))`; the
  computed `jkt` (RFC 7638 thumbprint) equals `expectedJkt`.
- **Server nonce** (optional, RFC 9449 §8/§9) — when `expectedNonce` is supplied,
  the proof's `nonce` claim must equal it (else `nonce_mismatch`). The proof's
  `nonce` is surfaced on the result either way so a caller can answer a mismatch
  with a `use_dpop_nonce` error and a fresh `DPoP-Nonce`.

`verifyDpopProof` never throws — failures return `{ valid: false, reason }` with
a stable `DpopFailureReason` code (the proof's `nonce` is also surfaced on a
`nonce_mismatch`). On success it returns `{ valid: true, jti, jkt, nonce? }`.

## Out of scope

- Replay detection storage (the caller owns the `jti` cache).
- `DPoP-Nonce` issuance and rotation, and emitting the `use_dpop_nonce` error
  (the caller owns the nonce lifecycle; this lib only checks the proof's `nonce`
  against the `expectedNonce` it is given).
- Access-token validation beyond the DPoP binding checks.

## License

[ISC](../../LICENSE)
