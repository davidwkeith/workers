# `@dwk/vc`

| | |
|---|---|
| **Type** | endpoint (+ lib) |
| **Ships a DO?** | no |
| **Standard** | [did:web](https://w3c-ccg.github.io/did-method-web/) · [VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) · [Data Integrity](https://www.w3.org/TR/vc-data-integrity/) |
| **Status** | proposed — tracked in [#61](https://github.com/davidwkeith/workers/issues/61) |

Decentralized identity rooted at the user's own domain. `did:web` reuses the
same WebID / IndieAuth identity root, expressed as a DID; Verifiable Credential
issuance and verification reuse [`@dwk/rdf`](rdf.md) (JSON-LD) and the project's
signature primitives, making this a low-marginal-cost capability.

## Worker vs. Anglesite (the static split)

- The **`did:web` DID document is a static file** (`/.well-known/did.json`, or
  `/<path>/did.json`) → **Anglesite generates it.** No Worker is needed for DID
  resolution.
- The **dynamic parts** that justify this package:
  - a VC **issuance** endpoint that signs a credential with the domain's key;
  - a VC **verification** endpoint;
  - **status / revocation** (e.g. a Bitstring Status List) — the status-list
    artifact MAY be static, but flipping a credential's status is stateful and
    wants a strongly-consistent store.

## Functional requirements

- Export `createVc(config)` returning the standard handler for the dynamic
  endpoints above.
- Issue and verify **Data Integrity** proofs over JSON-LD credentials via
  WebCrypto, reusing the `@dwk/dpop` / [`@dwk/http-signatures`](http-signatures.md)
  crypto posture (asymmetric, explicit `alg` allow-list).
- Optionally manage a revocation status list (D1-backed) when revocation is in
  scope.

## Design constraints

- Credential construction / proof logic takes **plain-data inputs** and SHOULD
  be unit-testable without a Workers runtime; only the issuance/status endpoints
  and their storage touch the runtime.
- No reading from the global environment — signing keys and issuer identity are
  passed via config / secret bindings (composition contract).

## Bindings (declared `Env` fragment)

- Signing key material (secret binding), shared with the published `did.json`
  verification method.
- **D1** (optional) for the revocation status list.

## Config

- `baseUrl` / domain and the DID identifier (`did:web:<domain>`).
- Issuer metadata and accepted credential types.
- Whether revocation / status lists are enabled.

## Conformance / testing

- W3C VCDM 2.0, Data Integrity, and did:web. Confirm credential `@context`
  documents fit the `@dwk/rdf` v1 JSON-LD subset
  ([open-questions.md](../open-questions.md) §4). See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Open questions

- v1 scope: issuance only, or issuance + verification + status?
- Signing-key overlap with `@dwk/indieauth` and the eventual Solid-OIDC OP
  ([open-questions.md](../open-questions.md) §1).
