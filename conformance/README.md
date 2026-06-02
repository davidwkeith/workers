# Conformance & release gate

Interop is the release bar (see
[`spec/conformance-and-testing.md`](../spec/conformance-and-testing.md)). This
directory holds the machine-readable status that turns "conformance" from a
nice-to-have into an enforced gate.

## `status.json`

A single source of truth for every workspace package:

```jsonc
"@dwk/micropub": {
  "standard": "Micropub",
  "suites": {
    "micropub.rocks": { "status": "pending", "report": null, "lastRun": null },
  },
  "integration": { "status": "pending", "cases": [] },
},
```

`status` is one of `pending`, `failing`, `passing`, `not-applicable`.

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

## Integration lifecycle tests

The four verb-lifecycle cases the spec requires live as colocated integration
tests in `packages/solid-pod/src/index.test.ts` and run under `workerd` via
`@cloudflare/vitest-pool-workers` (`pnpm test:integration`):

1. authenticated `GET` routed through WAC,
2. `PATCH` with a `solid:where` match,
3. `PATCH` whose `where` does not bind (expect **409**),
4. `If-Match` / ETag preconditioned writes.
