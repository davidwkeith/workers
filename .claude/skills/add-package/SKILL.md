---
name: add-package
description: Scaffold a new @dwk/* package in this monorepo — the required file shape, and how to choose between the Node and workerd vitest environments. Use when adding a package under packages/.
---

# Adding a package

Every package follows the same shape:

```
packages/<name>/
  src/index.ts          # public surface; *.ts siblings for internal modules
  src/*.test.ts         # colocated tests (excluded from the published build)
  package.json          # ESM-only, sideEffects:false, exports map to dist/
  tsconfig.json         # typecheck (noEmit), extends ../../tsconfig.base.json
  tsconfig.build.json   # build to dist/, excludes *.test.ts
  vitest.config.ts      # per-package vitest project
  README.md
  CLAUDE.md             # what this is / spec pointer / key constraints
```

`package.json` publishes `dist` + `src` (minus tests). See the root `CLAUDE.md`
"Code conventions" section for the ESM/typing/`index.ts` rules that apply to
every package.

## Choosing the test environment (get this right)

Each package's `vitest.config.ts` picks one of two environments:

- **`environment: "node"`** — pure libs that take plain-data inputs and need no
  Workers runtime, plus packages that are inherently Node-specific
  (`@dwk/cf-shims`, `@dwk/server`) or runtime-agnostic with Node-backed test
  fakes (`@dwk/deno-host`).
- **`workerd`** via `@cloudflare/vitest-pool-workers`
  (`cloudflareTest({ miniflare: {...} })`) — anything that touches a Cloudflare
  binding, and anything built on a Workers runtime global. `@dwk/mf2` is the
  one lib in this group: its extractor/sanitizer run on `HTMLRewriter`, with no
  bindings.

Packages needing Miniflare setup keep a `test-harness.ts`, excluded from both
the build and the published `files`.

The root `vitest.config.ts` aggregates all package projects, so `pnpm test` runs
both groups in one pass — add the new project there.

## Before opening the PR

- Add a catalog decision in `catalog.json` (a worker entry, or a `libraries`
  exclusion) — `pnpm catalog:check` enforces this.
- Add the package to `conformance/status.json`.
- Write `spec/packages/<name>.md`; it is the authoritative requirements doc.
- Record a changeset (`pnpm changeset`).
