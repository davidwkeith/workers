---
"@dwk/indieauth": minor
"@dwk/micropub": minor
"@dwk/solid-pod": minor
---

Adopt the injectable `@dwk/log` logging and metrics seams in the remaining
endpoint packages, so auth/authz decisions and validation rejections are no
longer silently swallowed (see `spec/observability.md`). Each package now depends
on `@dwk/log`, accepts an optional `logger` and `metrics` in its config
(defaulting to no-ops), owns an exported event taxonomy, and passes the same
`(event, fields)` to both seams. Redaction follows the cross-cutting policy:
only machine-readable reason codes, hosts (`hostFromUrl`), HTTP method/status,
and scopes are recorded — never tokens, codes, proofs, or bodies.

- **`@dwk/indieauth`** (`IndieAuthLogEvent`): authorization rejections by reason
  (`client_id_invalid`, `redirect_uri_not_permitted`, `pkce_required`, …), code
  issuance, token issuance, token-endpoint rejections by reason
  (`invalid_grant`, `pkce_failed`, `dpop_invalid`, …), and revocations.
- **`@dwk/micropub`** (`MicropubLogEvent`): authorization rejections by error
  code, validation rejections by reason (`invalid_body`, `media_too_large`,
  `missing_type`, …), action completions by verb, and media stored.
- **`@dwk/solid-pod`** (`SolidPodLogEvent`): edge-authentication rejections by
  reason and acceptances are emitted by the stateless front door. Because a
  Durable Object cannot receive the injected seams across the isolate boundary,
  the DO signals its WAC denials, anonymous-write refusals, and DPoP replay
  rejections back to the front door via an internal `x-solid-outcome` response
  header; the front door — the composition boundary where the seams are wired —
  emits the matching events and strips the header before replying to the client.
