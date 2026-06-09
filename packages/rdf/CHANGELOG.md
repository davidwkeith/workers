# @dwk/rdf

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.

## 0.1.0-beta.0

### Minor Changes

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
- 3a806d9: Implement `@dwk/rdf`: Turtle-family parse/serialize over N3.js (Turtle, TriG,
  N-Triples, N-Quads), a dependency-free JSON-LD ⇄ RDF converter for the edge
  (inline contexts, `@vocab`/`@base`/`@language`, term/prefix expansion, `@type`
  coercion, `@list`, `@graph`, `@reverse`; expanded/flattened serialization that
  round-trips), media-type content-negotiation entry points (`parse` /
  `serialize`), and triple ↔ store helpers (`quadToStored` / `storedToQuad`) for
  `@dwk/store` and `@dwk/solid-pod`.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- 9224fd7: Fix JSON-LD ⇄ RDF conformance bugs in `@dwk/rdf` (#38):
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
