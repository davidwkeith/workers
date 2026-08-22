---
"@dwk/http-signatures": patch
---

`verifyMessage` gains a `requireBodyDigest` option: when a `body` is supplied
and the signature covers neither `content-digest` nor `digest`, verification
now fails with `body_digest_required` instead of silently returning
`valid: true` with the body's integrity never actually checked. Off by
default — a caller that intentionally verifies headers only is not forced to
opt out.
