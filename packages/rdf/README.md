# `@dwk/rdf`

> Thin Turtle/JSON-LD parse and serialize layer over N3.js. Cross-standard reusable.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/rdf.md) for the full requirements.

This package is **cross-standard reusable**: it takes plain-data inputs only,
has no Workers-runtime dependency, and unit-tests in isolation (Node, no
`workerd`).

## API

### Turtle family (over N3.js)

```ts
import { parseTurtle, writeTurtle } from "@dwk/rdf";

const quads = parseTurtle(turtleString, { baseIRI });
const out = await writeTurtle(quads, { format: "N-Triples" });
```

`format` accepts the N3.js identifiers `"Turtle"`, `"TriG"`, `"N-Triples"`,
`"N-Quads"`.

### JSON-LD

```ts
import { parseJsonLd, writeJsonLd } from "@dwk/rdf";

const quads = await parseJsonLd(jsonLdStringOrObject, { base });
const out = await writeJsonLd(quads); // expanded / flattened form
```

### Content negotiation

`parse` / `serialize` dispatch by media type — the entry points
`@dwk/solid-pod` uses for content negotiation:

```ts
import { parse, serialize, formatForMediaType } from "@dwk/rdf";

const quads = await parse(body, request.headers.get("content-type")!);
const body = await serialize(quads, "text/turtle");
```

Recognized media types: `text/turtle`, `application/trig`,
`application/n-triples`, `application/n-quads`, `application/ld+json`.
Media-type parameters (e.g. `; charset=utf-8`, `; profile=…`) and casing are
ignored. Note `application/json` is **not** treated as RDF — JSON-LD's media
type is `application/ld+json`, and auto-parsing arbitrary `application/json`
bodies as a graph is a correctness/security hazard on write. (A read-only
`application/json` → JSON-LD convenience can be opted into at the negotiation
layer; `@dwk/solid-pod` does this on read.)

### Triple ↔ store helpers

`termToStored` / `storedToTerm` / `quadToStored` / `storedToQuad` convert
between RDF-JS terms/quads and a flat, JSON-serializable `StoredQuad` shape that
maps onto the DO-SQLite columns in [`@dwk/store`](../store) and survives a
structured-clone boundary.

```ts
import { quadToStored, storedToQuad } from "@dwk/rdf";

const row = quadToStored(quad); // { subject, predicate, object, graph }
const quad = storedToQuad(row);
```

## JSON-LD: the chosen approach and supported subset

N3.js does not handle JSON-LD, and `jsonld.js` is too large for the Worker
script-size budget (see
[non-functional-requirements.md](../../spec/non-functional-requirements.md#runtime-budget)).
This package therefore ships a **dependency-free JSON-LD ⇄ RDF converter** (zero
added bytes beyond N3.js) implementing a pragmatic subset of JSON-LD 1.0
toRDF/fromRDF — the decision that resolves
[open-questions.md §4](../../spec/open-questions.md).

**Parse (JSON-LD → quads) supports:**

- Inline `@context` (object, or array of objects); context arrays; resetting
  with `null`.
- Context features: term → IRI mappings, prefix/CURIE expansion (`prefix:term`),
  `@vocab`, `@base`, default `@language`, and expanded term definitions with
  `@id`, `@type` (datatype IRI, `@id`, or `@vocab`), `@language`, and
  `@container: @list`.
- Node objects with `@id` (IRIs and `_:` blank nodes), `@type`, nested node
  objects, and node references.
- Value objects (`@value` + `@type` / `@language`) and native scalars typed per
  JSON-LD rules (string → `xsd:string` or a language string, integer →
  `xsd:integer`, fractional → `xsd:double` in canonical lexical form, boolean →
  `xsd:boolean`). A `@value` of `null` produces no triple. Relative `@id`/IRIs
  that no `@base`/`base` resolves to an absolute IRI are dropped rather than
  emitted as invalid terms.
- Lists (`@container: @list` and inline `@list`) → `rdf:first`/`rdf:rest`/
  `rdf:nil`.
- `@graph`: top-level wrapper (default graph) and named graphs (a node with
  `@id` + `@graph`).
- `@reverse` properties.

**Serialize (quads → JSON-LD)** emits **expanded / flattened** form (node
objects keyed by full IRIs, no `@context`), reconstructing well-formed
`rdf:first`/`rdf:rest`/`rdf:nil` chains back into `@list`. This form round-trips
through `parseJsonLd` at the RDF (quad) level. One inherent caveat: an empty
`@list` becomes `rdf:nil`, which the JSON-LD data model cannot distinguish from
a property whose value is literally `rdf:nil`, so empty lists serialize as an
`rdf:nil` reference.

**Out of scope for v1** (documented limitations; `JsonLdError` is thrown where
detectable):

- **Remote / URL contexts** — contexts must be inlined. A string `@context`
  throws.
- Framing and `@reverse` containers, `@index` / `@included` maps, `@nest`,
  scoped contexts, type-scoped contexts, and JSON-LD 1.1 `@json` / `@direction`.
- Compaction to a supplied context on serialize — output is always expanded.

These are sufficient for Solid/IndieWeb content negotiation, where documents are
served with controlled, inlinable contexts. The subset can be widened later
without changing the public API.

## License

[ISC](../../LICENSE)
