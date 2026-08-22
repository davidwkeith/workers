---
"@dwk/rdf": minor
---

Implement `@dwk/rdf`: Turtle-family parse/serialize over N3.js (Turtle, TriG,
N-Triples, N-Quads), a dependency-free JSON-LD ⇄ RDF converter for the edge
(inline contexts, `@vocab`/`@base`/`@language`, term/prefix expansion, `@type`
coercion, `@list`, `@graph`, `@reverse`; expanded/flattened serialization that
round-trips), media-type content-negotiation entry points (`parse` /
`serialize`), and triple ↔ store helpers (`quadToStored` / `storedToQuad`) for
`@dwk/store` and `@dwk/solid-pod`.
