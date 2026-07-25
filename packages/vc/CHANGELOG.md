# @dwk/vc

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/safe-fetch@0.1.0-beta.4

## 0.1.0-beta.4

### Minor Changes

- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).

### Patch Changes

- bde0341: Close two critical identity-binding gaps found in the pre-1.0 code review, both
  on unauthenticated / attacker-controlled paths:

  - **`@dwk/activitypub`: actor impersonation via the default key resolver
    (#287, #288).** Inbound HTTP-signature verification trusted the `owner`
    field of whatever document the attacker-supplied `keyId` served, so a key
    document hosted at `https://evil.example/key` could declare
    `owner: https://victim.example/users/alice` and have signed activities
    attributed to the victim. The default resolver now binds the resolved
    `owner` to the origin that **actually served** the key — the final URL after
    any redirects, not the requested `keyId`, so an open redirect on the
    requested origin cannot smuggle attacker-served content in under it — and the
    `keyId` fetch runs through `@dwk/safe-fetch`'s
    `safeFetch` — `https:`-only, with private/loopback/link-local hosts blocked
    and **every redirect hop re-validated** (so a public host cannot `302` the
    fetch onto an internal address), plaintext `http:` no longer accepted, and a
    bounded, size-capped body read — instead of an unguarded `fetch`.

  - **`@dwk/vc`: credential forgery via unbound `verificationMethod` (#289).**
    Proof verification never tied the proof's `verificationMethod` to the
    credential's `issuer`, so a credential naming any `issuer` could be signed
    with an attacker's own key and still verify. `verifySingleProof` now
    requires the verification method's controller (its declared `controller`,
    or the DID/URL portion of the method id) to equal the credential's issuer
    before the key is trusted. A new optional `expectedController` on
    `VerifyProofOptions` allows overriding the bound party for non-issuance
    proof purposes (e.g. a presentation's `authentication` proof).

- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Minor Changes

- 22c802a: Move the status-list SSRF-safe fetch onto the shared `@dwk/safe-fetch`
  package instead of a package-local copy (no behavior change). Also close a
  gap where `createDidWebResolver`'s DID-document fetch had **no** SSRF
  protection or timeout at all (#215) — it now goes through the same
  `safeFetch` guardrails as the status-list fetch. `DidWebResolverOptions.fetch`
  widens from a narrow `{ ok, status, json() }` shape to a full `Response`-
  returning `FetchLike`, matching `@dwk/safe-fetch`'s type — a minor bump for
  any caller supplying a custom fetch implementation.

### Patch Changes

- 18a5310: Harden two unauthenticated/attacker-controlled fetch paths found in a
  Cloudflare Workers best-practices review:

  - `@dwk/activitypub`: the inbox and owner-publish endpoints now cap the
    request body (2 MB) before buffering it, rejecting oversized bodies with
    413 instead of letting an unauthenticated federation peer control how much
    memory the Worker allocates.
  - `@dwk/vc`: verifying a foreign `credentialStatus.statusListCredential` URL
    (attacker-controlled, taken from the credential under verification) now
    goes through an SSRF-safe fetch — https-only, private/reserved hosts
    blocked (previously only the scheme was checked), a bounded timeout, and a
    capped response body read — instead of an unguarded `fetch`.

- Updated dependencies [6d14fc3]
- Updated dependencies [7b86416]
- Updated dependencies [22c802a]
  - @dwk/log@0.1.0-beta.3
  - @dwk/safe-fetch@0.1.0-beta.2

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- da63790: Add `@dwk/vc` — `did:web` identity plus Verifiable Credential (VCDM 2.0)
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

### Patch Changes

- 604646f: Verification-side hardening from a VC standards-compliance audit (issue #98):
  - **Enforce `@context` consistency on verify.** `verifySingleProof` now requires
    the secured document's `@context` to begin with every value in the proof's
    `@context`, in order (vc-di-eddsa §3.3.2 step 4.1); a divergence yields
    `verified: false` instead of being ignored.
  - **Constrain `proofValue` to base58-btc on verify.** Both JCS cryptosuites
    mandate a `z`-prefixed (base58-btc) `proofValue`; verification now rejects any
    other multibase encoding (e.g. base64url `u`) rather than silently decoding it.
  - **Error on an invalid `created` datetime at signing.** `addProof` validates the
    proof's `created` against the XSD `dateTimeStamp` lexical space and throws on a
    malformed value (vc-di-eddsa §3.3.5 step 3); `buildCredential` and
    `buildStatusListCredential` validate `validFrom`/`validUntil` the same way.
  - **`checkValidityPeriod` fails closed.** A present-but-unparseable `validUntil`
    is treated as expired (and a malformed `validFrom` as not-yet-valid) instead of
    being read as "no expiry"; bounds must be valid XSD `dateTimeStamp`s.
  - **Status-list caching bounds.** `buildStatusListCredential` accepts `validFrom`
    / `validUntil` and now advertises `ttl` on the credential as well as its
    subject.
  - **One-or-more `statusPurpose`.** The status-list credential/entry builders and
    `findStatusEntry` accept an array of purposes, per the Bitstring Status List
    spec.

  New exports: `isValidXsdDateTimeStamp`, `toXsdDateTime`, and the
  `StatusPurposeValue` type.

- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
