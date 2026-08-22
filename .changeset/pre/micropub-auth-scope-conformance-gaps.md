---
"@dwk/micropub": patch
---

Close four auth/scope and conformance gaps in `@dwk/micropub` (issue #39):

- **`create` no longer grants media uploads.** The media endpoint now
  authorizes with the dedicated `media` scope only, not `["media", "create"]`.
  A `create`-only token authorizes creating posts (including photos folded into
  a multipart create) but not arbitrary blob uploads to the media endpoint —
  least privilege, matching the distinct `media` scope advertised by `q=config`.
- **DPoP proof `jti` replay is now enforced.** `@dwk/dpop` proves a proof is
  fresh but, per RFC 9449, delegates replay detection to the caller. `authorize`
  now records each accepted `jti` in a new strongly-consistent, short-TTL D1
  table (`dpop_proofs` in `MICROPUB_DB`) and rejects a duplicate, so a captured
  proof can no longer be replayed within its acceptance window to repeat a
  state-changing request. The TTL spans `2 × DEFAULT_MAX_AGE_SECONDS` to cover
  the full window a proof stays cryptographically acceptable. Gated by the new
  `checkDpopReplay` config (default `true`).
- **Registered Micropub/OAuth error codes.** Error bodies that used the
  non-standard `not_found`/`conflict` codes now use `invalid_request` while
  keeping their `404`/`409` HTTP status, so conformance clients keying on
  `error` recognize them.
- **Update operands are stripped of `mp-*` commands.** `applyUpdate` previously
  applied `replace`/`add`/`delete` operands directly, letting a client persist
  `mp-slug`/`mp-syndicate-to` into stored properties (surfacing via `q=source`)
  where create rejects them. Update operands now run through the same `mp-*`
  command filtering as create, while real mf2 properties (`url`, `name`, …) pass
  through unchanged.
