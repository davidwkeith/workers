---
"@dwk/vc": patch
---

Scope the signer cache to each `createVc()` instance instead of a module-level
global, so independently configured instances in the same isolate no longer
share cache state.
