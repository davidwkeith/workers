---
"@dwk/vc": minor
---

Publish the Data Integrity proof pipeline as the `@dwk/vc/data-integrity` subpath export (`importSigner`, `addProof`, `verifyProof`, `encodeEd25519Multikey`, `decodeMultikey`), so consumers that only need proofs avoid the credential and `did:web` endpoint code.
