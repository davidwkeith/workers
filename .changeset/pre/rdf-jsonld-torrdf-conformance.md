---
"@dwk/rdf": patch
"@dwk/solid-pod": patch
---

Fix JSON-LD ⇄ RDF conformance bugs in `@dwk/rdf` (#38):

- **Relative IRIs are dropped, not emitted.** A relative `@id`/IRI that no
  `@base`/`base` resolves to an absolute IRI is now dropped (in subject, `@id`
  coercion, `@type`, and predicate position) rather than minting an invalid
  `NamedNode`.
- **Canonical `xsd:double`.** Doubles now serialize in canonical lexical form
  (mantissa with a decimal point, no trailing zeros, uppercase `E`, signed
  exponent — e.g. `1.0E2`, `1.0E-7`); numbers with magnitude `>= 1e21` map to
  `xsd:double`, and an explicit `xsd:double` `@type` forces the double form.
- **`@value: null` produces no triple** instead of a bogus `"null"` literal.
- **`@list` is reconstructed on serialize**, collapsing well-formed
  `rdf:first`/`rdf:rest`/`rdf:nil` chains back into `@list`. (An empty list is
  `rdf:nil`, which the JSON-LD data model cannot distinguish from a literal
  `rdf:nil` reference — documented.)
- **`application/json` is no longer treated as RDF.** JSON-LD's media type is
  `application/ld+json`; the `application/json` alias is removed from the RDF
  media-type registry so arbitrary JSON bodies can't be misparsed as a graph on
  write/PATCH. A read-only `application/json` → JSON-LD convenience remains as an
  explicit opt-in in `@dwk/solid-pod` content negotiation.
