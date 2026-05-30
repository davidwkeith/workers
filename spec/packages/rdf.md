# `@dwk/rdf`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Built on** | [N3.js](https://github.com/rdfjs/N3.js) |

Thin RDF parse/serialize layer. A **cross-standard reusable** — it MUST stay
free of IndieWeb/Solid assumptions so future `@dwk` packages can adopt it
unchanged.

## Functional requirements

- Parse and serialize **Turtle** and **JSON-LD** (at minimum) over **N3.js**.
- Provide **triple ↔ store** helper functions used by the quad store in
  [`@dwk/store`](store.md) and by `@dwk/solid-pod` content negotiation.

## Design constraints

- **Edge-budget-conscious.** Prefer N3.js. Do **NOT** pull in Comunica or
  jsonld.js if doing so blows the Worker script-size budget (see
  [non-functional-requirements.md](../non-functional-requirements.md#runtime-budget)).
- **Plain-data inputs only** — no Workers-runtime dependency; unit-testable in
  isolation.
- ESM-only, tree-shakeable, fully typed.

## Testing

- Round-trip unit tests (parse → serialize → parse) across Turtle and JSON-LD,
  including content-negotiation-relevant edge cases.
