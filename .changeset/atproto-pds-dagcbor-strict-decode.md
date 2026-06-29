---
"@dwk/atproto-pds": patch
---

Make the DAG-CBOR codec strict, matching the canonical profile the AT Protocol
data model requires.

DAG-CBOR bytes are content-addressed, so any non-canonical encoding of the same
data carries a different CID than a re-encode — accepting it silently is a
correctness bug. The codec now:

- **rejects floats** on both encode (a non-integer or non-finite number throws)
  and decode (a major-7 half/single/double-float head throws) — the atproto data
  model forbids floats outright;
- **rejects non-minimally-encoded integers** on decode (e.g. a value `< 24`
  carried in a one-byte follow);
- **rejects out-of-order or duplicate map keys** on decode (keys must be in
  length-first-then-bytewise canonical order).

Previously the decoder accepted all three, so a non-canonical block could round
-trip without its CID being challenged. This hardens the codec against malformed
or adversarial blocks (e.g. on CAR import).
