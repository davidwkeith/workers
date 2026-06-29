---
"@dwk/atproto-pds": patch
---

Verify every CAR block against its content address on inbound migration import
(`importRepoFromCar`).

The import path authenticated only the **root commit signature** and then trusted
the CAR's self-declared block CIDs when walking the MST and reading records. Block
bytes were never re-hashed against the CID they were filed under, so a malicious or
buggy source could swap MST-node or record bytes beneath the expected CIDs and the
root-commit signature would still verify while the recovered records were forged —
breaking the content-address chain the signature is supposed to anchor.

`importRepoFromCar` now recomputes each block's CIDv1/SHA-256 and rejects the CAR
(`block … does not match its content`) if any block fails to match, so the signed
root transitively authenticates every record before a single one is imported.
