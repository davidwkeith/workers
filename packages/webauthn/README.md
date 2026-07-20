# `@dwk/webauthn`

> WebAuthn / passkeys relying party: registration + authentication ceremonies
> over a per-relying-party Durable Object for challenge state and credential
> records.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/webauthn.md) for the full
requirements.

> **Status: exploratory, lowest priority.** This package is filed for
> completeness. A WebAuthn relying party is a clean technical fit for Workers —
> ceremonies plus a credential store, with challenge state mapping neatly onto a
> short-TTL Durable Object — but it is a step *away* from the "implement open
> *web-presence* standards" thesis and *toward* generic authentication. Prefer
> [`@dwk/indieauth`](../indieauth) as a site's primary identity mechanism; reach
> for this only if you specifically need passkeys. Tracked in
> [#64](https://github.com/davidwkeith/workers/issues/64).

## What it provides

A single factory, `createWebAuthn(config)`, returning a `fetch`-style handler
that exposes the four ceremony endpoints (mountable under any path prefix):

| Endpoint | Purpose |
| --- | --- |
| `POST /register/options` | Issue `PublicKeyCredentialCreationOptions` + a fresh challenge |
| `POST /register/verify` | Verify the attestation and store the credential |
| `POST /authenticate/options` | Issue `PublicKeyCredentialRequestOptions` + a fresh challenge |
| `POST /authenticate/verify` | Verify the assertion and advance the signature counter |

It also exports the `WebAuthnObject` Durable Object class (bind it as a
namespace), and the pure verification primitives (`verifyRegistration`,
`verifyAuthentication`, `parseClientData`, `parseAuthenticatorData`) for callers
who want to drive the ceremonies themselves.

## Architecture

A stateless front door routes each ceremony step to a per-relying-party Durable
Object keyed by `rpId`. The Durable Object is the consistency authority: it mints
and **single-use-consumes** short-TTL challenges and reads/writes credential
records (public key, signature counter, transports) in its SQLite, all strongly
consistent. **Challenge and credential state never live in KV** — a stale
challenge or counter is a security bug (see
[non-functional requirements](../../spec/non-functional-requirements.md)).

Verification runs entirely on **Web Crypto**: a minimal CBOR decoder reads the
attestation object and COSE public key, which is imported as a JWK and used to
verify attestation/assertion signatures (ECDSA signatures are unwrapped from
ASN.1 DER to the raw form Web Crypto expects). The only runtime dependency is
[`@dwk/log`](../log).

### Attestation scope

The relying party requests `attestation: "none"`, so the accepted attestation
statement formats are **`none`** and **`packed` self-attestation** (no `x5c`).
Verifying a full attestation-certificate chain (basic / AttCA attestation) is
intentionally out of scope — it proves authenticator provenance, which a
personal-site relying party does not need. A statement carrying `x5c` is rejected
rather than silently trusted.

## Usage

```ts
import { createWebAuthn, WebAuthnObject } from "@dwk/webauthn";

// Bind a Durable Object namespace `WEBAUTHN` to the WebAuthnObject class.
export { WebAuthnObject };

const webauthn = createWebAuthn({
  rpId: "example.com",
  rpName: "Example",
  origin: "https://example.com", // or an array of accepted origins
  // optional:
  // algorithms: [-7, -257],     // COSE alg ids (ES256, RS256) — the default
  // challengeTtlSeconds: 300,
  // userVerification: "preferred",
});

export default {
  fetch(request, env, ctx) {
    return webauthn(request, env, ctx); // mount under any prefix you like
  },
};
```

The browser glue is standard: pass the `/register/options` (or
`/authenticate/options`) JSON to `navigator.credentials.create()` /
`.get()` after base64url-decoding the binary fields, then base64url-encode the
credential response and POST it to the matching `verify` endpoint.

## Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `rpId` | — (required) | Relying party id (effective domain). |
| `rpName` | — (required) | Human-readable name for the authenticator UI. |
| `origin` | — (required) | Accepted client origin(s); matched exactly. |
| `algorithms` | `[-7, -257]` | Accepted COSE algorithms, most-preferred first. |
| `challengeTtlSeconds` | `300` | Challenge lifetime. |
| `timeoutMs` | `60000` | Ceremony timeout advertised to the client. |
| `userVerification` | `"preferred"` | `"required"` also rejects assertions whose UV flag is unset. |
| `authorize` | allow-all | Per-operation gate `(operation, request) => boolean`; return `false` for `401`. **Gate registration — see below.** |
| `logger` / `metrics` | no-op | Injectable `@dwk/log` seams for ceremony outcomes. |

> **⚠️ Gate registration.** `register/options` and `register/verify` bind a
> passkey to a **caller-supplied** `user.id`. If they are reachable
> unauthenticated, anyone can register their own authenticator against another
> user's id and then authenticate as that user — account takeover. The default
> `authorize` hook allows everything (matching `@dwk/vc`), so **the composing
> front door owns this decision**. When no hook is supplied the factory emits a
> loud `webauthn.config.registration_unguarded` warning on the injected logger
> at startup rather than degrading silently. Supply an `authorize` that requires
> an established session for the `register/*` operations, e.g.:
>
> ```ts
> createWebAuthn({
>   rpId, rpName, origin,
>   authorize: (op, req) =>
>     op.startsWith("authenticate/") || hasAuthenticatedSession(req),
> });
> ```

Per the [composition contract](../../spec/composition-contract.md), the package
never reads the global environment: all config is passed into the factory, and a
missing `WEBAUTHN` Durable Object binding fails loudly at startup.

## License

ISC
