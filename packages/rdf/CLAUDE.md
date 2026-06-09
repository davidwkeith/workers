# @dwk/rdf

RDF parse/serialize library — a cross-standard reusable.

## What this is

Thin wrapper over N3.js for Turtle-family formats (Turtle, N-Triples, N-Quads,
TriG) plus a lightweight JSON-LD path. Provides content-negotiation entry points
(`parse`/`serialize` by media type), triple-to-stored-term conversion for the
quad store, and format detection helpers. Edge-budget-conscious — no jsonld.js
or Comunica.

## Spec

`spec/packages/rdf.md` — authoritative requirements.

## Key constraints

- **Protocol-agnostic.** No IndieWeb/Solid assumptions. Reusable by any `@dwk`
  package that handles RDF.
- **No Cloudflare imports.** Pure-data library, tests under Node.
- **Budget-conscious.** Prefer N3.js. Never ship Comunica or jsonld.js if it
  blows the 3 MB script-size budget. The JSON-LD path is intentionally minimal.
- **ESM-only.** N3.js 2.x is ESM; the `readable-stream` polyfill alias is only
  needed in workerd consumers (solid-pod), not here.

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/rdf
pnpm test --project @dwk/rdf jsonld     # single file by substring
```

## File layout

```
src/index.ts       # public surface: parse, serialize, format helpers, stored-term converters
src/turtle.ts      # N3.js Turtle parse/write
src/jsonld.ts      # lightweight JSON-LD parse/write
src/formats.ts     # media-type → format mapping
src/stored.ts      # quad ↔ stored-term conversion for DO SQLite
src/*.test.ts      # colocated tests
```

## Dependencies

- `n3` (2.0.3) — Turtle family parser/writer.
- `@types/n3` (1.26.1) — type definitions.

## Depended on by

`@dwk/ldn`, `@dwk/store`, `@dwk/wac`, `@dwk/solid-pod`
