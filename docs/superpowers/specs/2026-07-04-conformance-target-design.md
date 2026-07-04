# Hosted conformance testing: target Worker + suite runners

**Date:** 2026-07-04
**Status:** Approved (design), not yet implemented
**Related:** `spec/conformance-and-testing.md`, `conformance/status.json`,
`scripts/conformance/run-suite.mjs`, `.github/workflows/conformance.yml`,
issue #12

## Problem

Every hosted conformance suite (micropub.rocks, webmention.rocks, websub.rocks,
the Solid conformance test harness, litmus) exercises a **deployed, publicly
reachable** endpoint. The repo has the plumbing — the dispatcher, the
`status.json` source of truth, the release gate, and the `hosted-suite` CI
job — but **no deployable target exists anywhere** (no wrangler config, no
composed Worker). Every suite in `status.json` is `pending` because there is
nothing to point them at.

## Decisions (settled during brainstorming)

1. **Persistent conformance Worker**, not ephemeral CI deploys or tunnels —
   the web-UI suites need a stable URL you register interactively.
2. **Everything mounted up front**; suites brought online incrementally
   against the same deployment.
3. **Automate what's scriptable** (litmus, webmention.rocks, Solid harness);
   micropub.rocks / websub.rocks stay documented manual procedures.
4. **CI deploys to a custom domain** — `conformance.dwk.io` — via
   `cloudflare/wrangler-action` and repo secrets.
5. The target lives at **`packages/conformance-target`** as a private
   workspace package (precedent: `@dwk/server`), doubling as the living
   reference composition.

## 1. `packages/conformance-target` (`@dwk/conformance-target`)

Private (`"private": true`, never published) workspace package following the
standard package shape (tsconfig pair, vitest project, README).

### Composition (`src/index.ts`)

One Worker `fetch` handler routing path prefixes to each endpoint package's
factory, per the composition contract:

| Mount | Package / factory |
| --- | --- |
| `/.well-known/webfinger` | `@dwk/webfinger` |
| `/.well-known/host-meta` | `@dwk/host-meta` |
| `/auth/*` (authorization, token, metadata) | `@dwk/indieauth` |
| `/micropub` | `@dwk/micropub` |
| `/microsub` | `@dwk/microsub` |
| `/webmention` | `@dwk/webmention` |
| `/websub` | `@dwk/websub` |
| ActivityPub actor + `/inbox`, `/outbox` | `@dwk/activitypub` |
| `/storage/*` | `@dwk/remotestorage` |
| `/pod/*` (LDP) | `@dwk/solid-pod` |
| `/dav/*` | `createSolidPodWebdav` + `createSolidPodWebdavCredentials` |
| `/webauthn/*` | `@dwk/webauthn` |
| `/vc/*` | `@dwk/vc` |
| `/xrpc/*` | `@dwk/atproto-pds` |
| `/` and test-content pages | small static handler (test identity homepage: h-card, rel=me, endpoint discovery links, webmention test posts) |

Exact prefixes follow each package's README/spec where one is prescribed
(e.g. `.well-known` paths are fixed by their standards); the table above is
the default layout, adjustable during implementation.

- **Config, not env:** every factory receives its config object (base URL
  `https://conformance.dwk.io`, issuer, allowed origins, the test identity)
  from a single `config.ts`. No package reads the global environment.
- **Env union:** `Env` is the union of every mounted package's fragment —
  the five Durable Objects (`SolidPodObject`, ActivityPub actor,
  remoteStorage account, WebAuthn RP, atproto repository), one R2 bucket,
  D1 database(s), and secrets. Startup fails loudly if a binding is missing
  (composition-contract requirement — the target also serves as the test
  that the contract actually composes).
- **Discovery content:** the root page is the test identity — an h-card with
  IndieAuth/Micropub/Webmention/WebSub discovery links, WebID document for
  Solid, actor document for ActivityPub — because several suites start from
  URL discovery, not from the endpoint itself.

### `wrangler.jsonc`

Checked in, with all bindings declared (DO migrations, R2 bucket, D1), the
custom-domain route `conformance.dwk.io`, and observability enabled. Secrets
(signing keys, test-account password hashes) are set via
`wrangler secret`/dashboard, never committed.

### Smoke test (normal CI)

A workerd vitest project (`test-harness.ts` + Miniflare, same as the other
runtime-bound packages) asserting every mount answers its cheapest
discovery/health request (e.g. webfinger 200, micropub config query 401/200,
`OPTIONS /dav/`, pod root GET). This catches composition regressions in
ordinary `pnpm test` with no deploy. It is a smoke test only — protocol
correctness stays in each package's own tests.

## 2. Deploy pipeline

A `deploy-target` job added to `conformance.yml` (same workflow as the
suites, so the schedule can chain them):

- **Triggers:** `workflow_dispatch`, and as a `needs:` dependency of the
  weekly scheduled `hosted-suite` run (deploy fresh, then test).
- **Steps:** pnpm install → `pnpm build` → `cloudflare/wrangler-action` with
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets, running
  `wrangler deploy` in `packages/conformance-target`.
- **One-time manual setup (documented in the package README):** create the
  API token, add the two secrets, ensure the `dwk.io` zone is on the
  account, set the Worker secrets, seed the test identity (owner WebID,
  IndieAuth password/credential, WebDAV app password minted post-deploy).

## 3. Suite runners

`scripts/conformance/run-suite.mjs` stays the single seam. Per suite:

| Suite | Mode | Plan |
| --- | --- | --- |
| **litmus** (`webdav`) | already automated | Point at `https://conformance.dwk.io/dav/…` with a minted app password. No dispatcher change needed beyond docs. |
| **webmention.rocks** | new automated runner | *Sender:* drive the `@dwk/webmention` sender at each `webmention.rocks/test/N` page (discovery + delivery), assert the test endpoint accepts. *Receiver:* trigger their receiver tests against `https://conformance.dwk.io/webmention` (source pages hosted on the target's static handler), then verify the mentions were stored/verified via the package's query surface. Runner lives in `scripts/conformance/` and is invoked by the dispatcher when `--target` is set. |
| **Solid conformance-test-harness** | CI Docker job, after a spike | The harness authenticates via Solid-OIDC (client credentials / login flows). **Spike first:** determine what `@dwk/solid-pod`'s DPoP-based auth must expose for the harness to log in, and whether a subset profile is the right initial scope. Outcome of the spike defines the P4 work. |
| **micropub.rocks** | manual runbook | `docs/conformance/micropub-rocks.md`: register the endpoint, obtain a token via the deployed IndieAuth, click through, publish the implementation report, record result. |
| **websub.rocks** | manual runbook | Same pattern, `docs/conformance/websub-rocks.md`. |
| **remoteStorage api-test-suite** | later (P5) | CLI suite; automatable in CI against `/storage`. |
| **atproto interop** (`goat`, CAR round-trip) | later (P5) | Scripted checks against `/xrpc`. |
| **VC test suites**, **WebAuthn** | later (P5) | Documented pending; wired as each comes up. |

The dispatcher's existing behaviour is preserved: no `--target` → print the
procedure and exit 0.

## 4. Recording results — `scripts/conformance/record.mjs`

One script both CI and manual runs use to write results into
`conformance/status.json`:

```
node scripts/conformance/record.mjs \
  --package @dwk/webdav --suite litmus \
  --status passing --target-id cloudflare \
  [--report <url>]
```

- Sets `status`, `report`, `lastRun` (ISO date) in the right column
  (top-level for `cloudflare`, `targets.<id>` otherwise).
- Validates the result against `conformance/status.schema.json` before
  writing; refuses unknown package/suite names.
- CI suite jobs call it after a green run and upload the suite output as an
  artifact; committing the change happens via a PR (manual or a follow-up
  automation — out of scope here).

## 5. Phasing

1. **P1** — `conformance-target` package + smoke test + deploy workflow +
   `conformance.dwk.io` route → run **litmus** green. (Closes the "hosted
   litmus run is the remaining increment" item.)
2. **P2** — webmention.rocks runner (sender + receiver) automated.
3. **P3** — `record.mjs` + manual runbooks for micropub.rocks /
   websub.rocks; first manual results recorded.
4. **P4** — Solid harness spike, then the CI Docker job.
5. **P5** — long tail: remoteStorage api-test-suite, atproto interop, VC,
   WebAuthn.

Each phase is its own plan/PR. `status.json` flips suites from `pending` as
they go green; the release gate mechanics are unchanged.

## Error handling & operational notes

- The target Worker is **test infrastructure with real auth**: it must not
  accept unauthenticated writes. Suites get real tokens/app passwords from
  the deployed auth endpoints, same as production composition would.
- Suite data accumulates in the DO/R2/D1 of the conformance deployment; a
  documented reset procedure (delete + redeploy, or a gated admin purge
  route) is part of the P1 README so reruns start clean.
- Scheduled weekly runs that fail (e.g. third-party suite outage) must not
  flip a `passing` entry back automatically — `record.mjs` is only invoked
  on definitive results; transient failures surface as red CI runs.

## Out of scope

- Automating the micropub.rocks / websub.rocks web UIs (headless browser) —
  explicitly rejected as brittle.
- The `node` target column (`@dwk/server` deployments) — same runners apply
  later via `--target-id node`, but standing up a public Node host is not
  part of this design.
- Auto-committing `status.json` changes from CI.
