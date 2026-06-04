# `@dwk/vc`

> `did:web` identity plus Verifiable Credential (VCDM 2.0) issuance,
> verification, and revocation. Endpoint package (+ lib).

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/vc.md) for the full requirements.

Decentralized identity rooted at the user's **own** domain. `did:web` is the same
WebID / IndieAuth identity root expressed as a DID, and Verifiable Credential
proofs reuse the project's asymmetric, allow-listed crypto posture — making
decentralized identity a low-marginal-cost capability on top of the rest of the
cohort.

## Worker vs. static (the split)

- The **`did:web` DID document is a static file** (`/.well-known/did.json`).
  [`buildDidDocument`](src/did-web.ts) produces it — a static host (Anglesite)
  can serve it, and **no Worker is needed to resolve a DID**.
- The Worker covers the **dynamic** parts: signing credentials with the domain's
  key (**issuance**), **verification**, and **status / revocation**, whose
  bit-flips need a strongly-consistent store.

## Proofs: JCS Data Integrity, not RDF canonicalization

Proofs use the **JCS** Data Integrity cryptosuites — `eddsa-jcs-2022` (Ed25519)
and `ecdsa-jcs-2019` (ECDSA P-256/P-384) — which canonicalize with
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JSON), **not** RDF Dataset
Canonicalization. That keeps the package free of a JSON-LD/RDF canonicalizer
(`jsonld.js`/Comunica), well within the Worker script-size budget, and makes
proof construction a pure, plain-data transform that unit-tests without a Workers
runtime. Signing/verification mirror `@dwk/dpop` and `@dwk/http-signatures`:
asymmetric only, an explicit cryptosuite allow-list, and keys validated against
the claimed suite.

## Usage

```ts
import { createVc } from "@dwk/vc";

const vc = createVc({
  baseUrl: "https://example.com",
  // did defaults to did:web:example.com; verificationMethod to ${did}#key-0
  status: { enabled: true }, // revocation via a Bitstring Status List
});

// Bindings (composition contract):
//   VC_SIGNING_KEY  secret — the issuer's PRIVATE signing key as JWK JSON
//   VC_STATUS_DB    D1     — authoritative status bits (required iff status.enabled)

// In your Worker's fetch handler, mount the dynamic endpoints:
//   POST /credentials/issue           { credential }            → { verifiableCredential }
//   POST /credentials/verify          { verifiableCredential }  → { verified, errors, warnings }
//   POST /credentials/status          { credential | statusListIndex } → { status: "ok" }
//   GET  /credentials/status-lists/revocation                   → signed BitstringStatusListCredential
return vc(request, env, ctx);
```

The signing key's public half must be published in the DID document's
verification method. Generate the document statically:

```ts
import { buildDidDocument, encodeEd25519Multikey } from "@dwk/vc";

const didDocument = buildDidDocument({
  did: "did:web:example.com",
  verificationMethods: [
    { id: "#key-0", publicKeyMultibase: encodeEd25519Multikey(rawEd25519PublicKey) },
  ],
});
// → write to /.well-known/did.json
```

### Issuance / verification as a library

Credential construction and the proof pipeline take plain-data inputs and need no
runtime:

```ts
import { buildCredential, importSigner, addProof, verifyProof } from "@dwk/vc";

const signer = await importSigner(privateJwk); // picks the cryptosuite by key type
const credential = buildCredential({
  issuer: "did:web:example.com",
  credentialSubject: { id: "did:web:alice.example", alumniOf: "Example U" },
  type: "AlumniCredential",
});
const vc = await addProof(credential, signer, {
  verificationMethod: "did:web:example.com#key-0",
});

const result = await verifyProof(vc, {
  resolveVerificationMethod: createDidWebResolver(), // did:web over fetch
});
// → { verified: boolean, errors: string[] }
```

## Endpoints

- `POST {issueEndpoint}` (default `/credentials/issue`) — signs a credential with
  the domain's key. When `status.enabled`, allocates and attaches a
  `BitstringStatusListEntry` unless the request opts out (`credentialStatus:
  false`) or the credential already carries one. → `{ verifiableCredential }`.
- `POST {verifyEndpoint}` (default `/credentials/verify`) — structural (VCDM 2.0)
  + validity-period + Data Integrity proof + status checks. Resolves keys via the
  configured resolver (default `did:web`). → `{ verified, errors, warnings }`.
- `POST {statusEndpoint}` (default `/credentials/status`) — flips a credential's
  status bit in D1 (revoke by default). Accepts a full `credential` (reads its
  status entry) or an explicit `statusListIndex`. `404` when status is disabled.
- `GET {statusListEndpoint}/<purpose>` (default `/credentials/status-lists/…`) —
  serves the **signed** `BitstringStatusListCredential` for that purpose.

Issuance and status are gated by the optional `authorize(operation, request)`
hook; when omitted, the composing Worker's front door owns edge token validation
(see [`spec/architecture.md`](../../spec/architecture.md)). Unmatched routes get
`404`; wrong methods get `405`.

## Design

- **Confinement / composition contract:** signing keys and issuer identity arrive
  via config and secret bindings, never the global environment. The package
  **fails loudly** when a required binding is missing (`VC_SIGNING_KEY`,
  `VC_STATUS_DB` when status is enabled).
- **Strong consistency:** authoritative status bits live in **D1**, never KV —
  staleness in a revocation check is a security bug
  ([`spec/non-functional-requirements.md`](../../spec/non-functional-requirements.md)).
- **Pure core:** `canonicalize` (JCS), the multibase/Multikey codecs, `addProof`
  /`verifyProof`, the `did:web` mapping, and the bitstring codec are plain-data
  (Web Crypto / `CompressionStream` only) and unit-test in isolation; only the
  endpoints and the status store touch the runtime.

## Observability

Issuance, verification, status changes, and rejections are emitted through the
injected `@dwk/log` `Logger`/`Metrics` seams (default no-op): `vc.issued`,
`vc.verified`, `vc.status.changed`, `vc.rejected`. Credential subjects, claims,
signing keys, and proof values are **never** logged.

## Conformance

W3C VCDM 2.0, Data Integrity, and `did:web`. Status is tracked in
[`conformance/status.json`](../../conformance/status.json) and gated for stable
releases (see [`spec/conformance-and-testing.md`](../../spec/conformance-and-testing.md)).
