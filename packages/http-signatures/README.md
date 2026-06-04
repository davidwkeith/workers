# `@dwk/http-signatures`

> HTTP Message Signatures (RFC 9421) sign/verify, with the legacy
> `draft-cavage-http-signatures` profile for fediverse interop. Cross-standard
> reusable.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/http-signatures.md) for the full
requirements.

This package is **cross-standard reusable**: it takes plain-data inputs only
(method, URL, headers) plus a resolved `CryptoKey`, has no Workers-runtime
dependency (only Web Crypto), and unit-tests in isolation (Node, no `workerd`).
It is **protocol-agnostic** — it knows nothing about ActivityPub, IndieWeb, or
Solid. Key resolution (fetching an actor's public key, caching it) is the
caller's responsibility, supplied as a `KeyResolver`.

It mirrors the [`@dwk/dpop`](../dpop/README.md) hardening posture: only
asymmetric algorithms from an explicit allow-list are accepted — never `none`
or HMAC — and a resolved key is validated against the claimed algorithm (RSA
modulus floor of 2048 bits, EC curve) before any signature is checked.

## API

### Signing (RFC 9421)

```ts
import { signMessage, createContentDigest } from "@dwk/http-signatures";

const body = JSON.stringify(activity);

// Cover the body by digesting it and listing the digest among the components.
const headers = {
  host: "remote.example",
  date: new Date().toUTCString(),
  "content-type": "application/activity+json",
  "content-digest": await createContentDigest(body),
};

const sig = await signMessage(
  { method: "POST", url: "https://remote.example/inbox", headers },
  {
    key: privateKey, // a private CryptoKey you imported for `alg`
    keyId: "https://me.example/actor#main-key",
    alg: "ed25519",
    components: ["@method", "@target-uri", "@authority", "date", "content-digest"],
    // created defaults to now; expires, nonce, tag, label are optional
  },
);

// Merge sig (Signature-Input + Signature) into the outbound request headers.
await fetch("https://remote.example/inbox", {
  method: "POST",
  headers: { ...headers, ...sig },
  body,
});
```

### Verifying

```ts
import { verifyMessage } from "@dwk/http-signatures";

const result = await verifyMessage(
  { method: request.method, url: request.url, headers },
  {
    // Resolve the public key for the claimed keyid (fetch the actor, cache it).
    resolveKey: async ({ keyId, alg }) => fetchActorKey(keyId, alg),
    requiredComponents: ["@method", "@target-uri", "date", "content-digest"],
    body, // optional: also recompute & check any covered content-digest/digest
  },
);

if (!result.valid) {
  // result.reason is a stable code, e.g. "signature_invalid", "key_unresolved"
  return new Response("bad signature", { status: 401 });
}
// result.keyId is the verified principal; result.coveredComponents the audit trail.
```

The profile is auto-detected from the headers (a `Signature-Input` header means
RFC 9421, otherwise the legacy single `Signature` header is parsed as
`draft-cavage`); pass `profile` to force one.

### `draft-cavage` (fediverse)

```ts
import { signMessage, createDigest } from "@dwk/http-signatures";

const headers = {
  host: "remote.example",
  date: new Date().toUTCString(),
  digest: await createDigest(body), // legacy "SHA-256=<base64>" header
};

const sig = await signMessage(
  { method: "POST", url: "https://remote.example/inbox", headers },
  {
    profile: "cavage",
    key: privateKey,
    keyId: "https://me.example/actor#main-key",
    alg: "rsa-v1_5-sha256", // serialized as algorithm="rsa-sha256"
    components: ["(request-target)", "host", "date", "digest"],
  },
);
```

## What is verified

- **Profile** — `Signature-Input` / `Signature` (RFC 9421) or the single
  `Signature` header (`draft-cavage`), auto-detected unless forced.
- **Algorithm** — from the allow-list (`rsa-pss-sha512`, `rsa-v1_5-sha256`,
  `ecdsa-p256-sha256`, `ecdsa-p384-sha384`, `ed25519`); never `none` or HMAC.
- **Key** — the resolved `CryptoKey`'s algorithm and EC curve must match the
  claimed algorithm, and RSA moduli must be at least 2048 bits.
- **Signature** — over the reconstructed signature base / signing string.
- **Window** — `created` not in the future and `expires` not in the past,
  within `toleranceSeconds` (default 300).
- **Coverage** — every component named in the signature is reconstructed from
  the message; `requiredComponents` lets the caller insist specific components
  were covered.
- **Body integrity** (optional) — when a `body` is supplied and a
  `content-digest` (RFC 9530) or legacy `Digest` component is covered, the
  header is recomputed over the body and must match.

`verifyMessage` never throws — failures return `{ valid: false, reason }` with a
stable `SignatureFailureReason` code. On success it returns
`{ valid: true, profile, keyId, coveredComponents, created?, expires? }`.

## Out of scope

- **Key resolution and caching** — the caller supplies a `KeyResolver` and owns
  fetching/importing the public key (PEM/JWK → `CryptoKey`) and any caching.
- **Replay/nonce storage** — the caller owns nonce bookkeeping.
- **Component parameters** — `;sf`, `;key`, `;bs`, `@query-param`, and response
  components (`@status`) are not derived; a signature covering them is reported
  as `components_malformed` rather than guessed at.

## License

[ISC](../../LICENSE)
