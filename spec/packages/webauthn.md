# `@dwk/webauthn`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** (challenge state) |
| **Standard** | [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) |
| **Status** | implemented, unreleased — **exploratory, lowest priority** — tracked in [#64](https://github.com/davidwkeith/workers/issues/64) |

A WebAuthn / passkeys relying party. Filed for completeness, **not** as a
near-term recommendation: it is a technically clean Workers fit but a step *away*
from the "implement open *web-presence* standards" thesis and *toward* generic
authentication. The open question below (does an auth method belong in this scope
at all?) remains open; prefer [`@dwk/indieauth`](indieauth.md) as a site's
primary identity mechanism.

## Worker vs. Anglesite (the static split)

Fully **dynamic** — registration / authentication options, challenge issuance,
and attestation / assertion verification all require server logic and
per-ceremony state. Nothing here is a static document, so none of it can live in
Anglesite.

## Functional requirements

- Export `createWebAuthn(config)` returning the standard handler exposing
  `/register/options`, `/register/verify`, `/authenticate/options`,
  `/authenticate/verify`.
- Issue and consume short-TTL challenges; verify attestation (registration) and
  assertion (authentication) via WebCrypto.
- Persist credential records: credential id, public key, signature counter, and
  transports.

**As implemented:** the relying party requests `attestation: "none"`, so
attestation verification covers the `none` and `packed` *self*-attestation
formats (no `x5c`); full attestation-certificate-chain verification is out of
scope (it proves authenticator provenance, which a personal-site RP does not
need). Challenge state **and** credential records live together in the per-RP
Durable Object's SQLite. Accepted signature algorithms mirror `@dwk/dpop`
(ES256/ES384, RS256/PS256), offered as `pubKeyCredParams` `[-7, -257]` by
default. A non-increasing signature counter is rejected (cloned-authenticator
detection), tolerating the all-zero counter authenticators that do not implement
one.

## Design constraints

- **Challenge state** lives in a per-relying-party Durable Object (short TTL,
  strongly consistent); credential records in the DO or D1. Authn state **MUST
  NOT** use KV — staleness is a security bug
  ([non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- Configurable RP ID / origin, passed via config — no global-environment reads
  (composition contract).

## Bindings (declared `Env` fragment)

- **Durable Object namespace** for challenge state.
- **D1** (or the same DO) for credential records.

## Config

- `baseUrl` / domain, RP ID, and expected origin(s).
- Challenge TTL and supported algorithms.

## Open questions

- Does an authentication method belong in this scope at all, or is it an
  out-of-band Anglesite / host concern?
- Relationship to [`@dwk/indieauth`](indieauth.md) as the site's primary
  identity mechanism.
