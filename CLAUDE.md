# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@dwk/workers` is a pnpm-workspace monorepo of composable npm packages that each
implement an open web standard (the **IndieWeb, Solid, and Fediverse cohort**,
plus shared identity/auth, discovery, and storage primitives), run as
[Cloudflare Workers](https://developers.cloudflare.com/workers/), and deploy onto
an end user's **own** Cloudflare account. There is no hosted product and no
central server: a developer `npm install`s the packages, composes them into one
Worker behind one domain, and deploys to the user's account.

**Status: implemented, unreleased.** Every package under `packages/` carries real
logic with colocated tests; there are no remaining `501 Not Implemented` stubs.
Two packages are never published: `@dwk/server`, the Node/Express self-hosting
host (marked `"private": true`, ships only as a Docker image), and
`@dwk/conformance-target`, the deployed conformance Worker (`conformance.dwk.io`)
every endpoint package composes into for the hosted suites.

Versioning is via Changesets **pre mode** (`.changeset/pre.json`, tag `beta`);
packages publish as `0.1.0-beta.N` prereleases, independent per package. Note
that in pre mode, packages with no prior stable release publish to the
**`latest`** dist-tag, not `beta`, so plain `npm i @dwk/<pkg>` is the channel —
see [`RELEASING.md`](./RELEASING.md) for the full release runbook.

Per-package conformance and integration status lives in
`conformance/status.json` (`@dwk/webdav`'s litmus findings are in
`conformance/webdav-qa.md`). Plain-data libs that declare no bindings carry
`integration: not-applicable` — they have no deployed lifecycle to run.

`@dwk/webdav` and `@dwk/mastodon-api` are the packages still landing in
increments; each package's own `CLAUDE.md` and `spec/packages/<name>.md` state
where it stands. When changing behaviour, the authoritative requirements are the
per-package specs under `spec/packages/`, not guesswork.

## Commands

Run from the repo root (pnpm 10, Node >=22 — `@dwk/server`'s built-in
`node:sqlite` shims need it). Task scripts are in the root `package.json`; what
isn't obvious from there is how to target a subset.

This is a multi-project vitest setup, so always scope with `--project`; a bare
file/name filter errors against projects that don't match:

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
`webmention`) is stateless handlers backed by D1 / R2; the packages that ship a
**Durable Object** are `@dwk/solid-pod` (per-pod), `@dwk/activitypub`
(per-actor), `@dwk/remotestorage` (per-account), `@dwk/webauthn` (per-RP), and
`@dwk/atproto-pds` (per-account repository). `@dwk/store` ships no DO of its
own — it is the DO-SQLite + R2 storage library instantiated _inside_ a
consuming package's DO (`solid-pod`, `remotestorage`) against the object's
injected state.

### Package taxonomy

Four buckets. Each package's own `packages/<name>/CLAUDE.md` describes it
individually; what follows is only the classification and the constraints that
ride on it.

- **Endpoint / standard packages** — named for the standard they implement.
  `@dwk/atproto-pds` is the strategic outlier: it shares neither `@dwk/store`
  nor `@dwk/rdf` (its repository is an MST of DAG-CBOR records), so its storage
  core is self-contained, and it is **exploratory/strategic** rather than
  committed — see its spec. `@dwk/mastodon-api` reads `@dwk/activitypub`'s DO
  only through its injected `MastodonBackend` seam; `@dwk/solid-oidc` is
  composed from `@dwk/oauth`'s primitives per `spec/open-questions.md` §1.
- **Cross-standard reusable libs** — `@dwk/rdf`, `@dwk/dpop`, `@dwk/log`,
  `@dwk/ldn`, `@dwk/http-signatures`, `@dwk/oauth`, `@dwk/calendar`,
  `@dwk/safe-fetch`, `@dwk/esi`. These MUST stay free of IndieWeb/Solid
  assumptions so future `@dwk` standards adopt them unchanged. **This is a hard
  constraint, not a preference.** Corollaries that are easy to get wrong:
  `@dwk/ldn`'s discovery helpers must stay reachable n3-free as
  `@dwk/ldn/discovery` for Workers-runtime consumers, and per-standard calendar
  adapters (e.g. `h-event → CalendarEvent`) live in the endpoint packages, never
  in `@dwk/calendar`. `@dwk/log` is the injectable structured-logging seam (see
  `spec/observability.md`).
- **Standard-specific libs** — `@dwk/wac` (tied to Solid/WAC by design) and
  `@dwk/mf2` (microformats2, an IndieWeb building block).
- **Storage and runtime-emulation libs** — `@dwk/store` confines all Cloudflare
  storage specifics. `@dwk/cf-shims` (Node) and `@dwk/deno-host` (Deno) are
  deliberately Cloudflare-_interface_-shaped for the same reason: they implement
  the binding contracts so a non-Cloudflare host runs the same packages
  unchanged. `@dwk/cf-shims` may use `node:` imports; `@dwk/deno-host` MUST NOT
  — it takes injected client seams only, so it runs anywhere. See
  `spec/self-hosting.md` §16 and `spec/portability.md`.

**Any package that fetches an attacker- or user-supplied URL MUST go through
`@dwk/safe-fetch`** (SSRF-safe outbound fetch + capped body read) — never a bare
`fetch`.

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

## Code conventions

These apply to every package. For the procedure and file shape when **adding** a
new package, use the `add-package` skill.

- **ESM-only**, tree-shakeable, fully typed (`.d.ts` shipped). `package.json`
  uses `"type": "module"`, `"sideEffects": false`, and an `exports` map pointing
  at `dist/`. Dependencies are **minimized and pinned** to exact versions.
- **Internal workspace deps** use `"workspace:*"`.
- **`index.ts` carries a doc comment** stating the package's role, whether it is
  pure/protocol-agnostic, and a `@see spec/packages/<name>.md` pointer. Match
  this style. `index.ts` is the public surface and mostly re-exports from named
  internal modules; endpoint packages decompose into `config.ts` (the injected
  config + `Env` fragment), `handler.ts` (the `createX` factory), and feature
  modules (`auth.ts`, `store.ts`, plus standard-specific ones).
- **TypeScript is strict** via `tsconfig.base.json` — use `import type` for
  type-only imports, and prefix deliberately-unused vars with `_`.

## Conventions

- **Contributor workflow:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) is the
  canonical onboarding doc (setup, the local CI gate, test targeting,
  changesets, adding a package, security reporting). Keep it in sync when
  commands or conventions in this file change.
- **Formatting:** Prettier, config at the repo root; `pnpm format:check` is a CI
  gate.
- **Commit messages & PR titles:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `<type>(<scope>): <subject>`, lowercase type, subject not capitalized, scope
  in parentheses (the package name minus the `@dwk/` prefix, comma-separated
  for several packages, omitted only for a repo-wide change). Types in use:
  `feat`, `fix`, `chore`, `docs`, `debug`. Correct:
  `fix(solid-pod): strip client-forged ldp:contains from container PUT`.
  Incorrect: `Fix solid-pod: strip client-forged ldp:contains from container PUT`
  (capitalized, colon instead of scope parens) and `Add AGENTS.md symlink to CLAUDE.md`
  (no type prefix at all). This repo squash-merges PRs, so the **PR title** —
  not just the individual commit messages on the branch — is what lands in
  `git log`; get the title right.
- **PR body:** open every PR from `.github/PULL_REQUEST_TEMPLATE.md` (GitHub
  pre-fills it automatically) and keep its section headings — `Summary`,
  `Packages affected`, `Checklist` — verbatim. Don't rename `Checklist` to
  `Verification` or replace it with free-form prose, and don't delete a
  checklist item that doesn't apply — leave it unchecked with a one-line
  reason instead (`- [ ] Updated catalog.json/conformance/status.json — not applicable, no new worker`).
- **Review threads:** resolve every review conversation before merging —
  either by pushing a fix and marking the thread resolved, or by replying
  with why no change is needed and then resolving it. Don't merge with
  outstanding unresolved threads.
- **Releases:** independent semver per package via **Changesets**. To record a
  change, run `pnpm changeset`, select the affected packages and bump, and commit
  the generated markdown in `.changeset/` alongside the code. `commit: false` —
  changesets does not auto-commit.
- **License:** ISC.

## Conformance & release gate

**Conformance is the release bar** (`spec/conformance-and-testing.md`): a
package MUST NOT publish a stable (`>=1.0.0`) version until it passes the
conformance suite for its standard (micropub.rocks, webmention.rocks, Solid
conformance) and its integration lifecycle tests are green. This is enforced
mechanically by `pnpm release:gate`, which `pnpm release` runs first — see
[`RELEASING.md`](./RELEASING.md) for the step-by-step publish runbook and
`node scripts/release-gate.mjs --report` for the current status table.

`conformance/status.json` (schema: `conformance/status.schema.json`) is the
single source of truth for per-package conformance + integration status.

`catalog.json` at the repo root is the machine-readable manifest of every
mountable worker, consumed by composing apps (Anglesite's Workers tab /
wrangler-config generation) over the same raw-file channel as `status.json`;
shape in `catalog.schema.json` + `spec/catalog.md`. **Worker `id`s are
forever-stable** — apps persist state against them, so never rename one.
`pnpm catalog:check` enforces that every publishable package has a catalog
decision (a worker entry or a `libraries` exclusion).

`.github/workflows/conformance.yml` is separate from `ci.yml`: the cheap
`release-gate` and `integration` jobs run on every PR/push, while `hosted-suite`
needs a deployed, publicly reachable Worker and so runs only on
`workflow_dispatch` or the weekly Monday schedule.

## Where the requirements live

`spec/` holds the authoritative technical requirements — read these before
implementing standards behaviour:

- `spec/overview.md`, `spec/architecture.md`, `spec/composition-contract.md`,
  `spec/non-functional-requirements.md`, `spec/conformance-and-testing.md`,
  `spec/open-questions.md`
- `spec/packages/<name>.md` — one detailed spec per package.

The broader requirements thread is
[issue #1](https://github.com/davidwkeith/workers/issues/1). For the
human-facing contributor guide see [`CONTRIBUTING.md`](./CONTRIBUTING.md); for
the publish runbook see [`RELEASING.md`](./RELEASING.md).
