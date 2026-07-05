---
"@dwk/atproto-pds": patch
---

`resolveDidDocument`'s `did:web` fetch and all three PLC-directory calls
(`submitPlcOperation`, `resolvePlcDid`, `fetchPlcData`) now go through
`@dwk/safe-fetch` (#215): a bounded timeout and redirect handling where
previously there was neither.
