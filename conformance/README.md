# Conformance & release gate

Interop is the release bar (see
[`spec/conformance-and-testing.md`](../spec/conformance-and-testing.md)). This
directory holds the machine-readable status that turns "conformance" from a
nice-to-have into an enforced gate.

## Deployed target

The suites run against `packages/conformance-target` — a private Worker
composing every endpoint package, deployed to https://conformance.dwk.io via
the `deploy-target` job in `.github/workflows/conformance.yml`. See
`packages/conformance-target/README.md` for setup and per-suite runbooks.

## `status.json`

A single source of truth for every workspace package:

```jsonc
"@dwk/micropub": {
  "standard": "Micropub",
  "suites": {
    "micropub.rocks": {
      "status": "pending", "report": null, "lastRun": null,
      "targets": { "node": { "status": "pending", "report": null, "lastRun": null } },
    },
  },
  "integration": {
    "status": "pending", "cases": [],
    "targets": { "node": { "status": "passing" } },
  },
},
```

`status` is one of `pending`, `failing`, `passing`, `not-applicable`.

## Targets: Cloudflare (primary) and the Node self-host

Conformance is tracked per **target**, declared at the top of `status.json`:

- **`cloudflare`** — Cloudflare Workers, the primary, recommended,
  conformance-certified target. The flat `status` on each suite/integration is
  this target.
- **`node`** — the self-hosted Node/Express host (the `@dwk/server` Docker image
  or `dwk-serve` bin). Recorded in the optional `targets.node` slot on a suite or
  integration block, plus the `@dwk/server` package's own row.

The Node host's **integration lifecycle is already green** for every package it
brings up end to end (the `@dwk/server` `phase2`–`phase5` tests), so those carry
`integration.targets.node = "passing"`. The **hosted suites** (micropub.rocks,
etc.) against a deployed Node host stay `pending` until a public `@dwk/server`
target is wired in — record them with
`run-suite.mjs <standard> --target <url> --target-id node`. The gate checks every
target's status, so a stable package must be green on each target it declares.

**`fedify`** is a third kind of entry, specific to
`@dwk/activitypub.suites.activitypub-federation.targets`: unlike `cloudflare`/
`node` (which deployment serves the package under test), `fedify` names the
*interop peer* the suite was run against — a scripted
[Fedify](https://fedify.dev/) actor
(`scripts/conformance/fedify-peer.mjs`), a second, automatable federation
implementation alongside manually-tested Mastodon (`node`) (issue #246).

## The gate

`scripts/release-gate.mjs` (run via `pnpm release:gate`) reads each package's
version and this file. A package is **gated** once its version is stable
(`major >= 1`, no prerelease tag). A gated package whose suites or integration
status is not `passing`/`not-applicable` blocks the release:

- It runs inside `pnpm release`, **before** `changeset publish`.
- It runs in CI on every PR/push (`.github/workflows/conformance.yml`).
- `pnpm release:gate -- --report` prints the status table without enforcing.

Because every package is currently `0.0.0`, nothing is gated yet — but the wiring
is live, so the first attempt to bump a package to `1.0.0` without recording its
conformance green will fail.

## Suites per standard

| Package           | Standard  | Suite(s)                                             |
| ----------------- | --------- | ---------------------------------------------------- |
| `@dwk/micropub`   | Micropub  | [micropub.rocks](https://micropub.rocks/)            |
| `@dwk/webmention` | Webmention| [webmention.rocks](https://webmention.rocks/) (recv + send) |
| `@dwk/solid-pod`  | Solid     | Solid conformance test harness + real-client interop |
| `@dwk/webdav`     | WebDAV    | [litmus](http://www.webdav.org/neon/litmus/) (basic, copymove, props, locks) |
| `@dwk/activitypub`| ActivityPub | Mastodon (manual, target `node`) + [Fedify](https://fedify.dev/) interop peer (target `fedify`) |
| `@dwk/indieauth`  | IndieAuth | integration + interop (no hosted "rocks" suite)      |
| libraries         | —         | unit/integration only                                |

## Running a hosted suite

The hosted suites exercise a **deployed, publicly reachable** Worker, so they
cannot run against in-process Miniflare. Point them at a deployed target:

```bash
node scripts/conformance/run-suite.mjs micropub --target https://example.com/micropub
```

Without `--target` the dispatcher prints the procedure and exits 0 (a documented
no-op, so ordinary CI stays green). After a suite passes, record the result —
including the published implementation-report URL for Micropub — by setting the
relevant entry in `status.json` to `passing`. The next release gate run will
then allow that package to go stable.

**WebDAV/litmus is executable, not just documented.** litmus is a real CLI, so
the dispatcher actually runs it when given a target and Basic credentials (an app
password minted via the owner-gated endpoint), exiting with litmus's status:

```bash
WEBDAV_USERNAME=… WEBDAV_PASSWORD=… \
  node scripts/conformance/run-suite.mjs webdav --target https://pod.example
```

The `hosted-suite` workflow installs litmus and supplies the credentials from the
`WEBDAV_USERNAME` / `WEBDAV_PASSWORD` repo secrets on manual dispatch or the
weekly schedule.

**ActivityPub/Fedify is executable too.** The Fedify peer needs a public URL to
receive callbacks (e.g. a free Cloudflare Quick Tunnel:
`cloudflared tunnel --url http://localhost:8765`) for every case but the
read-only `webfinger` one:

```bash
node scripts/conformance/run-suite.mjs activitypub \
  --target https://example.com/actor --peer-url https://<tunnel>.trycloudflare.com
```

`scripts/conformance/fedify-peer.mjs` can also be run standalone (see its own
usage comment) for `--case webfinger,follow,activities,fanout,rsvp`; `fanout`
and `rsvp` are reported `skipped`, not silently dropped, without
`--publish-trigger`/`--event`. Record `activitypub-federation` ->
`targets` -> `fedify` as `passing` once every non-skipped case passes.

## Integration lifecycle tests

The four verb-lifecycle cases the spec requires live as colocated integration
tests in `packages/solid-pod/src/index.test.ts` and run under `workerd` via
`@cloudflare/vitest-pool-workers` (`pnpm test:integration`):

1. authenticated `GET` routed through WAC,
2. `PATCH` with a `solid:where` match,
3. `PATCH` whose `where` does not bind (expect **409**),
4. `If-Match` / ETag preconditioned writes.
