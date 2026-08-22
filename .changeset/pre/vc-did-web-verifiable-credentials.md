---
"@dwk/vc": minor
---

Add `@dwk/vc` — `did:web` identity plus Verifiable Credential (VCDM 2.0)
issuance, verification, and Bitstring Status List revocation.

- **`createVc(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler, routing `POST` issue /
  verify / status endpoints and serving signed `BitstringStatusListCredential`s
  at `GET {statusListEndpoint}/<purpose>`. Endpoint URLs, the issuer DID, the
  verification method, and the status policy are all config-supplied; the signing
  key arrives via the `VC_SIGNING_KEY` secret binding and the status store via the
  `VC_STATUS_DB` D1 binding — never read from the global environment.
- **Data Integrity proofs** over JSON credentials using the **JCS** cryptosuites
  `eddsa-jcs-2022` (Ed25519) and `ecdsa-jcs-2019` (ECDSA P-256/P-384), so the
  package canonicalizes with RFC 8785 (`canonicalize`) instead of shipping a
  JSON-LD/RDF canonicalizer — staying within the Worker script-size budget.
  Signing/verification mirror the `@dwk/dpop` / `@dwk/http-signatures` posture:
  asymmetric only, an explicit cryptosuite allow-list, keys validated against the
  claimed suite. `addProof` / `verifyProof` are pure (Web Crypto only).
- **`did:web`** helpers: `buildDidDocument` produces the static
  `/.well-known/did.json` (Anglesite's job — no Worker needed to resolve a DID),
  `didWebToUrl` / `urlToDidWeb` map identifiers, and `createDidWebResolver`
  fetches a controller's document to locate a verification key during
  verification.
- **Bitstring Status List**: a GZIP + multibase-base64url codec, credential/entry
  builders, and a **D1-backed** authority (`createVcStatusStore`) for flipping
  revocation/suspension bits — authoritative status lives in a strongly-consistent
  store, never KV. Verification reads the bit (own list via D1, foreign list via
  fetch) and rejects revoked credentials.
- **Multibase / Multikey** codecs (base58-btc, base64url, Ed25519 Multikey) and
  the JCS canonicalizer are exported for reuse. Endpoint-rejection, issuance,
  verification, and status events flow through the `@dwk/log` `Logger`/`Metrics`
  seams with subjects, claims, keys, and proof values never logged.
