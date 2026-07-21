---
"@dwk/rdf": patch
---

`parseJsonLd` now bounds node-value nesting depth (100 levels) during
expansion, rejecting a document nested deeper than that with a `JsonLdError`.
Previously a deeply nested `@dwk/rdf` input (mutually recursive
`processNode`/`valueToObject`) could overflow the call stack with an
uncatchable `RangeError`, escaping the package's `JsonLdError` contract.
