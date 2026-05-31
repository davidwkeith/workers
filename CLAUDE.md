# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@dwk/workers` is a pnpm-workspace monorepo of composable npm packages that each
implement an open web standard (the **IndieWeb + Solid cohort**), run as
[Cloudflare Workers](https://developers.cloudflare.com/workers/), and deploy onto
an end user's **own** Cloudflare account. There is no hosted product and no
central server: a developer `npm install`s the packages, composes them into one
Worker behind one domain, and deploys to the user's account.

**Status: draft / pre-implementation.** The libraries `@dwk/dpop`, `@dwk/rdf`,
`@dwk/wac`, and `@dwk/store` carry real logic; the endpoint packages
(`@dwk/indieauth`, `@dwk/micropub`, `@dwk/webmention`, `@dwk/solid-pod`) ship a
typed, stubbed public surface that returns `501 Not Implemented`. When
implementing behaviour, the authoritative requirements are the per-package specs
under `spec/packages/`, not guesswork.

## Commands

Run from the repo root (pnpm 10, Node >=20):

| Task                    | Command                                                      |
| ----------------------- | ------------------------------------------------------------ |
| Install                 | `pnpm install`                                               |
| Build all packages      | `pnpm build` (runs `tsc -p tsconfig.build.json` per package) |
| Typecheck all (no emit) | `pnpm typecheck`                                             |
| Run full test suite     | `pnpm test` (vitest, all package projects)                   |
| Watch tests             | `pnpm test:watch`                                            |
| Lint                    | `pnpm lint`                                                  |
| Format (write)          | `pnpm format`                                                |
| Format check (CI gate)  | `pnpm format:check`                                          |
| Record a release        | `pnpm changeset`                                             |

Targeting a subset (this is a multi-project vitest setup, so always scope with
`--project`; a bare file/name filter errors against projects that don't match):

```bash
# One package's tests by its vitest project name (see vitest.config.ts `name`)
pnpm test --project @dwk/dpop

# A single test file (filename substring) within a package
pnpm test --project @dwk/rdf jsonld

# A single test by name
pnpm test --project @dwk/dpop -t "verifies a valid proof"

# Build/typecheck a single package
pnpm --filter @dwk/wac build
pnpm --filter @dwk/wac typecheck
```

CI (`.github/workflows/ci.yml`) runs, in order: **lint → format:check →
typecheck → build → test**. All five must pass; match them locally before
pushing.

## Architecture

**Mental model:** stateless Worker front door (routing + edge token validation)
→ per-pod **Durable Object** as the consistency / authz / notification authority
→ **R2** for blob bodies. The IndieWeb trio (`indieauth`, `micropub`,
`webmention`) is stateless handlers backed by D1 / R2; `@dwk/solid-pod` is the
**only** package that ships a Durable Object.

### Package taxonomy

- **Endpoint packages** — named for the standard: `@dwk/indieauth`,
  `@dwk/micropub`, `@dwk/webmention`, `@dwk/solid-pod`.
- **Cross-standard reusable libs** — `@dwk/rdf`, `@dwk/dpop`. These MUST stay
  free of IndieWeb/Solid assumptions so future `@dwk` standards adopt them
  unchanged. This is a hard constraint, not a preference.
- **Standard-specific lib** — `@dwk/wac` (tied to Solid/WAC by design).
- **Storage lib** — `@dwk/store` confines all Cloudflare storage specifics.

### Composition contract (`spec/composition-contract.md`)

These rules are load-bearing; follow them when adding or changing packages:

- **Handler shape:** each endpoint package exports a factory
  `createX(config): (request, env, ctx) => Promise<Response>`. The handler must
  be mountable under a path prefix so several packages route inside one Worker.
- **Bindings contract:** each package declares the Cloudflare bindings it needs
  as a TypeScript `Env` interface fragment (R2/D1/DO/KV/secrets). The composed
  `Env` is the union of every mounted package's fragment. A package MUST **fail
  loudly at startup** if a required binding is missing — no silent degradation.
- **Config object:** packages MUST NOT read the global environment directly. All
  config (base URL, issuer, allowed origins, namespaces, thresholds) is passed
  into the factory, so a package can be instantiated multiple times and tested
  in isolation.
- **Confinement:** Cloudflare specifics live only in `@dwk/store` and the
  endpoint packages. `@dwk/wac`, `@dwk/rdf`, and `@dwk/dpop` take plain-data
  inputs so they unit-test without a Workers runtime.

### Non-functional rules (`spec/non-functional-requirements.md`)

- **Consistency:** authoritative state lives only in strongly-consistent stores
  (DO SQLite, R2, or D1 with session consistency). **KV MUST NEVER be used for
  authz or anything where staleness is a correctness/security bug** — KV is
  ~60 s eventually consistent, acceptable only for safe-to-be-stale caches.
- **No ACL / decision caching outside strongly-consistent layers.**
- **Runtime budget:** stay within Worker limits (128 MB memory, 3/10 MB script,
  1 s startup). **Stream R2 bodies through the Worker — never buffer a full blob
  in the DO.** Prefer **N3.js** for RDF; do not ship Comunica or jsonld.js if it
  blows the script-size budget. A DO SQLite cell is ~2 MB; RDF over that ceiling
  is offloaded to R2 as an opaque body.
- **DPoP everywhere** tokens are used; least-privilege bindings.

## Per-package layout & conventions

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
```

- **ESM-only**, tree-shakeable, fully typed (`.d.ts` shipped). `package.json`
  uses `"type": "module"`, `"sideEffects": false`, an `exports` map pointing at
  `dist/`, and publishes `dist` + `src` (minus tests). Dependencies are
  **minimized and pinned** to exact versions.
- **Internal workspace deps** use `"workspace:*"` (e.g. `@dwk/solid-pod` depends
  on `@dwk/dpop`, `@dwk/rdf`, `@dwk/store`, and `@dwk/wac`).
- **TypeScript is strict** via `tsconfig.base.json`: `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`/`Parameters`,
  `verbatimModuleSyntax`, `isolatedModules`. Use `import type` for type-only
  imports. ESLint flags unused vars unless prefixed with `_`.
- **`index.ts` carries a doc comment** stating the package's role, whether it is
  pure/protocol-agnostic, and a `@see spec/packages/<name>.md` pointer. Match
  this style.

### Test environment split (important)

Each package's `vitest.config.ts` picks one of two environments — get this right
when adding a package:

- **Pure libs run under Node** (`environment: "node"`): `@dwk/dpop`, `@dwk/rdf`,
  `@dwk/wac`. They take plain-data inputs and need no Workers runtime.
- **Runtime/binding-bound packages run under `workerd`** via
  `@cloudflare/vitest-pool-workers` (`cloudflareTest({ miniflare: {...} })`):
  `@dwk/store`, `@dwk/indieauth`, `@dwk/micropub`, `@dwk/webmention`,
  `@dwk/solid-pod`.

The root `vitest.config.ts` aggregates all package projects so `pnpm test` runs
both groups in one pass.

## Conventions

- **Formatting (Prettier):** semicolons, double quotes, trailing commas (`all`),
  80-column print width. `pnpm format:check` is a CI gate.
- **Releases:** independent semver per package via **Changesets**. To record a
  change, run `pnpm changeset`, select the affected packages and bump, and commit
  the generated markdown in `.changeset/` alongside the code. `commit: false` —
  changesets does not auto-commit.
- **Conformance is the release bar** (`spec/conformance-and-testing.md`): a
  package SHOULD NOT publish a stable (`>=1.0.0`) version until it passes the
  conformance suite for its standard (micropub.rocks, webmention.rocks, Solid
  conformance) and its integration lifecycle tests are green.
- **License:** ISC.

## Where the requirements live

`spec/` holds the authoritative technical requirements — read these before
implementing standards behaviour:

- `spec/overview.md`, `spec/architecture.md`, `spec/composition-contract.md`,
  `spec/non-functional-requirements.md`, `spec/conformance-and-testing.md`,
  `spec/open-questions.md`
- `spec/packages/<name>.md` — one detailed spec per package.

The broader requirements thread is
[issue #1](https://github.com/davidwkeith/workers/issues/1).
