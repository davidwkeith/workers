# Contributing

Thanks for your interest in `@dwk/workers` — a pnpm-workspace monorepo of
composable npm packages that each implement an open web standard and run as
[Cloudflare Workers](https://developers.cloudflare.com/workers/) on an end
user's **own** account. Start with the [README](./README.md) for what the
project is; this document covers how to work on it.

## Ground rules

- **The specs are the requirements.** Before changing behaviour, read the
  package's spec under [`spec/packages/`](./spec/packages/) and the
  cross-cutting documents ([`spec/composition-contract.md`](./spec/composition-contract.md),
  [`spec/non-functional-requirements.md`](./spec/non-functional-requirements.md)).
  If a change contradicts a spec, update the spec in the same PR or open an
  issue first — don't let code and spec drift apart. The broader requirements
  thread is [issue #1](https://github.com/davidwkeith/workers/issues/1).
- **Discuss significant changes first.** For new packages, new dependencies, or
  architectural changes, open an issue before writing code.
- **License:** contributions are accepted under the project's
  [ISC license](./LICENSE).

## Prerequisites

- **Node.js >= 22** (`@dwk/server`'s built-in `node:sqlite` shims need it; CI
  pins Node 24)
- **pnpm 10** (the exact version is pinned via `packageManager` in
  `package.json`; `corepack enable` will pick it up)

## Getting started

```bash
git clone https://github.com/davidwkeith/workers.git
cd workers
pnpm install
pnpm build       # tsc per package — required before tests (see below)
pnpm test        # full vitest suite, Node + workerd projects
```

> **Build before test.** Package tests import sibling `@dwk/*` workspace deps
> through their `exports` maps, which point at `dist/`. A fresh clone (or a
> change to a dependency package) needs `pnpm build` before the dependent
> package's tests will pass.

> **Windows: enable symlinks.** The repo tracks `AGENTS.md` as a symlink to
> `CLAUDE.md`. Without `core.symlinks=true` (requires Developer Mode or an
> admin `git clone`), Windows checkouts silently materialize it as a plain
> text file containing `CLAUDE.md` instead of the real guidance.

## Development workflow

1. **Branch** off `main`.
2. **Read the spec** for the package(s) you're touching.
3. **Make the change with colocated tests.** Every behaviour change needs a
   test in the package's `src/*.test.ts`.
4. **Run the CI gate locally**, in the same order CI does:

   ```bash
   pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test
   ```

   All five must pass — `.github/workflows/ci.yml` runs exactly this sequence.
   `pnpm format` fixes formatting violations in place.

5. **Record a changeset** for any user-visible change to a publishable
   package:

   ```bash
   pnpm changeset   # pick affected packages + bump type
   ```

   Commit the generated `.changeset/*.md` alongside the code (`commit: false`
   is set — changesets does not auto-commit). Repo-only changes (CI, docs,
   scripts) don't need one.

6. **Write commit messages (and the PR title) in Conventional Commits
   style**, matching the history: `<type>(<scope>): <subject>` — lowercase
   type, subject not capitalized, no trailing period. Common types: `feat`,
   `fix`, `chore`, `docs`. Scope is the package name minus the `@dwk/` prefix
   (`fix(solid-pod): …`), a comma-separated list for several packages
   (`fix(store,solid-pod): …`), or omitted for a repo-wide change
   (`chore: …`, `docs: …`).

   ✅ `fix(solid-pod): strip client-forged ldp:contains from container PUT`
   ❌ `Fix solid-pod: strip client-forged ldp:contains from container PUT` — capitalized, and a bare colon instead of a `(scope)`
   ❌ `Add AGENTS.md symlink to CLAUDE.md` — no type prefix at all

   This repo squash-merges PRs, so the **PR title** becomes the permanent
   history entry — get the title right, not just the commit messages on the
   branch.

7. **Open a pull request from `.github/PULL_REQUEST_TEMPLATE.md`.** GitHub
   pre-fills this body automatically when a PR is opened against the repo;
   keep its section headings (`Summary`, `Packages affected`, `Checklist`)
   verbatim instead of renaming or collapsing them into free-form prose (e.g.
   don't rename `Checklist` to `Verification`). Tick each checklist box, or
   leave it unchecked with a one-line reason if it doesn't apply — don't
   delete items that don't apply. Keep PRs focused and reference the issue
   they address.

## Running tests

This is a multi-project vitest setup — always scope with `--project` when
targeting a subset (a bare file/name filter errors against projects that don't
match):

```bash
# One package's tests, by its vitest project name
pnpm test --project @dwk/dpop

# A single test file (filename substring) within a package
pnpm test --project @dwk/rdf jsonld

# A single test by name
pnpm test --project @dwk/dpop -t "verifies a valid proof"

# Watch mode / coverage
pnpm test:watch
pnpm test:coverage

# Build or typecheck a single package
pnpm --filter @dwk/wac build
pnpm --filter @dwk/wac typecheck
```

### Test environment split

Each package's `vitest.config.ts` picks one of two environments — get this
right when adding or moving tests:

- **Pure libs run under Node** (`environment: "node"`): they take plain-data
  inputs and must need no Workers runtime (e.g. `@dwk/dpop`, `@dwk/rdf`,
  `@dwk/wac`, `@dwk/oauth`, `@dwk/http-signatures`, `@dwk/calendar`).
- **Runtime/binding-bound packages run under `workerd`** via
  `@cloudflare/vitest-pool-workers` (e.g. `@dwk/store`, `@dwk/solid-pod`,
  `@dwk/activitypub`, `@dwk/atproto-pds`). These keep their Miniflare setup in
  a `test-harness.ts` that is excluded from the build and the published
  `files`.

## Code conventions

- **Formatting:** Prettier — semicolons, double quotes, trailing commas
  (`all`), 80-column print width. `pnpm format:check` is a CI gate.
- **TypeScript is strict** (`tsconfig.base.json`): `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`,
  `verbatimModuleSyntax`, `isolatedModules`. Use `import type` for type-only
  imports. ESLint flags unused variables unless prefixed with `_`.
- **ESM-only packages**, tree-shakeable, fully typed, `"sideEffects": false`,
  `exports` maps pointing at `dist/`. Dependencies are minimized and pinned to
  exact versions; internal workspace deps use `"workspace:*"`.
- **`src/index.ts` is the public surface** and carries a doc comment stating
  the package's role, whether it is pure/protocol-agnostic, and a
  `@see spec/packages/<name>.md` pointer. Match this style.

### Architecture rules (load-bearing)

The full rules live in [`spec/composition-contract.md`](./spec/composition-contract.md)
and [`spec/non-functional-requirements.md`](./spec/non-functional-requirements.md);
the ones most often relevant to a PR:

- Endpoint packages export a factory
  `createX(config): (request, env, ctx) => Promise<Response>` mountable under
  a path prefix. Packages MUST NOT read the global environment directly — all
  config is injected — and MUST fail loudly at startup if a required binding
  is missing.
- Cloudflare specifics are confined to `@dwk/store` and the endpoint packages.
  Cross-standard libs (`@dwk/rdf`, `@dwk/dpop`, `@dwk/oauth`, …) MUST stay
  free of IndieWeb/Solid assumptions and unit-test without a Workers runtime.
  This is a hard constraint, not a preference.
- **KV MUST NEVER be used for authz** or anything where staleness is a
  correctness/security bug; authoritative state lives only in
  strongly-consistent stores (DO SQLite, R2, D1 with session consistency).
- Stay within the Worker runtime budget (128 MB memory, 3/10 MB script, 1 s
  startup). Stream R2 bodies through the Worker — never buffer a full blob in
  a Durable Object.

## Adding a new package

1. Write (or update) its spec in `spec/packages/<name>.md` first.
2. Follow the standard per-package layout (see the tree in
   [`CLAUDE.md`](./CLAUDE.md) → "Per-package layout & conventions"): `src/`
   with colocated `*.test.ts`, `tsconfig.json` + `tsconfig.build.json`,
   `vitest.config.ts`, `README.md`.
3. Pick the correct vitest environment (Node vs `workerd`, above).
4. Give it a **catalog decision**: either a worker entry in
   [`catalog.json`](./catalog.json) or a `libraries` exclusion —
   `pnpm catalog:check` enforces this for every publishable package. Worker
   `id`s are forever-stable once added.
5. Add its row to [`conformance/status.json`](./conformance/status.json); the
   release gate (`pnpm release:gate`) cross-checks it before any stable
   publish.

## Releases

You never publish from a laptop. Versioning is via Changesets **pre mode**
(tag `beta`), and publishing happens only through the gated **Release** GitHub
Actions workflow. All you need to do in a PR is record a changeset; see
[`RELEASING.md`](./RELEASING.md) for the full runbook, including the dist-tag
gotchas.

Stable (`>=1.0.0`) releases are additionally gated on conformance: a package
cannot publish a stable version until its suites in
`conformance/status.json` are `passing` or `not-applicable`
(see [`spec/conformance-and-testing.md`](./spec/conformance-and-testing.md)).

## Reporting bugs & security issues

- Open a [GitHub issue](https://github.com/davidwkeith/workers/issues) with
  reproduction steps and the package + version affected.
- For **security vulnerabilities**, please do not open a public issue — use
  [GitHub private vulnerability reporting](https://github.com/davidwkeith/workers/security/advisories/new)
  instead.
