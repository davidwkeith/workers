# `@dwk/oauth`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Used by** | [`@dwk/indieauth`](indieauth.md); the eventual Solid-OIDC OP |
| **Standard** | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) · [RFC 7662](https://www.rfc-editor.org/rfc/rfc7662) · [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) · [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126) · [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) |
| **Status** | implemented, unreleased — tracked in [#62](https://github.com/davidwkeith/workers/issues/62) |

The shared OAuth 2.0 server building blocks the **Solid-OIDC OP** open question
([open-questions.md](../open-questions.md) §1) will need, and that
[`@dwk/indieauth`](indieauth.md) already partially implements (PKCE, codes,
metadata, DPoP). Factoring them into one audited reusable keeps the eventual OP
and IndieAuth from diverging.

## Worker vs. Anglesite (the static split)

- The **authorization-server metadata document**
  (`/.well-known/oauth-authorization-server`, RFC 8414) is **static JSON**
  derived from config known at build time → **Anglesite can serve it.** No
  Worker route is needed merely to publish metadata.
- The **dynamic endpoints** this lib provides are stateful POST endpoints:
  - **token introspection** (RFC 7662),
  - **token revocation** (RFC 7009),
  - **pushed authorization requests** / PAR (RFC 9126),
  - **dynamic client registration** (RFC 7591).

## Functional requirements

- Provide handlers / handler factories for the four dynamic endpoints above,
  each mountable under a path prefix.
- Generate the RFC 8414 metadata document from config so the same source of
  truth drives both the static document (Anglesite) and runtime behaviour.
- Reuse [`@dwk/dpop`](dpop.md) for DPoP-bound tokens; share a consistent OAuth
  error registry with `@dwk/indieauth` (see the non-standard-error-code finding
  in [#39](https://github.com/davidwkeith/workers/issues/39)).

## Design constraints

- **Plain-data core:** token / client records are passed in and out; the
  storage binding is supplied by the consuming endpoint package via
  [`@dwk/store`](store.md). The core MUST unit-test **without a Workers runtime**.
- Authoritative token / client / PAR-request state **MUST** live in a
  strongly-consistent store (DO or D1 with session consistency) — **never KV**
  ([non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- **Protocol-agnostic:** no IndieWeb / Solid claim handling baked in; the caller
  supplies issuer / audience policy.

## Testing

- Unit tests per endpoint: introspection of active/expired/revoked tokens,
  revocation idempotency, PAR `request_uri` single-use + expiry, dynamic
  registration validation, and metadata-document shape.

## Open questions

- ~~Is this its own package, part of `@dwk/indieauth`, or the substrate for a
  future `@dwk/solid-oidc` OP?~~ **Resolved:** its own cross-standard reusable
  lib (`@dwk/oauth`), alongside `@dwk/dpop`/`@dwk/log`. `@dwk/indieauth` and the
  future OP compose it rather than re-implementing the primitives. The OP
  ownership question itself stays open in
  [open-questions.md](../open-questions.md) §1.
