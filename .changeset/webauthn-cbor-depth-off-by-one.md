---
"@dwk/webauthn": patch
---

Fix an off-by-one in the CBOR decoder's depth guard: `depth > MAX_DEPTH`
let a 33-level-deep structure through even though `MAX_DEPTH = 32` and its
doc comment promise a 32-level maximum. The guard is now `depth >=
MAX_DEPTH`, so the accepted maximum matches what's documented. Not
exploitable on its own (32 is already generous headroom over the 2-3 levels
real WebAuthn CBOR needs) — a correctness nit, not a new mitigation.
