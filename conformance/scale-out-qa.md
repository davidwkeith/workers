# Central mode (scale-out) — live verification & conformance QA runbook

Fillable, step-by-step companion to spec/scale-out.md §14 item 4's live
verification checklist and item 5's conformance bar, run against
[`packages/server/docker-compose.yml`](../packages/server/docker-compose.yml)
— the ≥2-replica sqld + MinIO + `@dwk/server` topology that doubles as both
the test bed and the deployment example (phase 5, #434). Unlike
`webdav-qa.md`/`micropub-qa.md` (which run against the always-on
`conformance.dwk.io` target), this suite stands up its own throwaway
deployment locally or in CI, runs it, and tears it down — there is no
persistent "central mode" conformance target.

Re-run this before every release that touches central mode
(`central-bindings.ts`, `central-mode.ts`, `central-durable-object.ts`,
`central-do-poller.ts`, `libsql-kv.ts`, or `@dwk/deno-host`'s
D1/R2/lease/alarm/queue modules) — not just once. Central mode is
**experimental, not supported** (host-contract §9) until every item below is
recorded passing.

## Scope

- **In scope:** the six live-verification items below (real sqld + real
  MinIO, not the in-memory fakes `central.integration.test.ts` already
  covers), plus running the hosted conformance suites against the
  compose reference's ≥2-replica deployment.
- **Out of scope:** anything the colocated unit/integration tests already
  prove against fakes (`libsql-kv.test.ts`'s key-encoding property tests,
  `central.integration.test.ts`'s two-fake-`DwkServer` suite,
  `central-do-activitypub.integration.test.ts`) — this runbook exists
  precisely because those tests _can't_ prove real-service behavior, not to
  duplicate what they already do prove. Also out of scope: the v2 residency
  design (§6.5, demand-gated) and any provider other than the sqld/MinIO
  pairing this compose file pins.

## Environment

|                       |                                                                   |
| --------------------- | ----------------------------------------------------------------- |
| Compose file          | `packages/server/docker-compose.yml`                              |
| Bring-up              | `docker compose -f packages/server/docker-compose.yml up --build` |
| Replicas              | `server1`, `server2` — both `examples/central-composition.mjs`    |
| Proxy (ingress)       | `http://localhost:8000` (nginx, round-robin + WS affinity)        |
| sqld (libSQL primary) | `http://localhost:8080`                                           |
| MinIO (S3 console)    | `http://localhost:9001`                                           |

## Prerequisites

- [ ] Docker + Docker Compose v2 (`docker compose version`).
- [ ] The repo built once so the compose build stage's `pnpm build` step
      has a warm pnpm store (not required, just faster): `pnpm install &&
pnpm build` from the repo root.
- [ ] Nothing else bound to ports 8000/8080/9000/9001 locally.

## Procedure

### Step 0 — Bring up the stack

```bash
docker compose -f packages/server/docker-compose.yml up --build -d
docker compose -f packages/server/docker-compose.yml ps
```

Both `server1` and `server2` should reach a healthy state (the Dockerfile's
own `HEALTHCHECK`); `sqld`/`minio` have no failed containers. If a replica is
stuck restarting, check its logs first — central mode fails loud at startup
(spec/scale-out.md §9.2), so a misconfigured deployment shows up here as a
clear `StartupProbeError`/`ModeMarkerConflictError`, not a silent hang:

```bash
docker compose -f packages/server/docker-compose.yml logs server1 --tail 50
```

- [ ] **Pass** — both replicas healthy
- [ ] **Fail** — logs/error: **************\_\_\_\_**************

### Step 1 — Live verification items (spec/scale-out.md §14 item 4, inheriting `spec/packages/deno-host.md`'s list)

Each item names what to check and a concrete way to check it against this
compose stack. Record pass/fail + notes for each; a partial pass (e.g. "reads
fine, batch atomicity unverified") is still a **fail** for that item — don't
round up.

1. **libSQL read-your-writes at the primary, over hrana, across sequential
   `execute` calls on one client.**
   Hit `/.well-known/oauth-authorization-server` (served by IndieAuth,
   backed by `AUTH_DB`) or write through any mounted D1-backed endpoint
   twice in a row against the _same_ replica and confirm the second read
   reflects the first write with no visible lag.
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

2. **`batch` atomicity/in-order execution over hrana under a mid-batch
   constraint failure.**
   Exercise an endpoint that performs a multi-statement `D1Database#batch`
   call (e.g. an IndieAuth token exchange, which writes/updates more than
   one row) with a request shaped to violate a constraint partway through;
   confirm via a follow-up read that **no** partial write landed.
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

3. **Embedded-replica write forwarding under concurrent replicas.**
   The central-mode Tier 2 sync-before-serve regression this compose file
   is built to exercise: write to a Durable-Object-backed resource via
   `server1` (`docker compose ... exec` a `curl` against `:8000` enough
   times that the LB round-robins you there, or `curl` `server1` directly
   inside the compose network), then immediately read the same resource via
   `server2`. Confirm `server2` sees the write with no additional delay
   beyond the request itself (this is what `central-do.integration.test.ts`
   proves against fakes — this step is the same assertion against a real
   `libsql` embedded-replica client and a real sqld primary).
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

4. **The `libsql` native module loads on the container base image.**
   Confirm neither replica logged a native-module load failure at startup
   (`docker compose ... logs server1 | grep -i libsql`) — the Dockerfile's
   `node:24-bookworm-slim` base is glibc, matching what the `libsql` npm
   package ships prebuilt binaries for; this step exists to catch a
   surprise (e.g. a future base-image switch to `alpine`/musl) rather than
   because failure is expected here.
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

5. **S3 provider (MinIO) read-after-write.**
   `PUT` an object through a mounted R2-backed endpoint (or directly via
   `mc`/`aws s3api` against `localhost:9000`), immediately `GET` it back
   (from either replica), confirm the bytes match with no propagation
   delay.
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

6. **Streaming-body signing (`aws4fetch` `PUT` with a `ReadableStream`).**
   Upload an object large enough that `@dwk/deno-host`'s R2 shim streams the
   body rather than buffering it (a few MB is enough to make buffering
   behavior visibly different in memory/timing) through a mounted R2-backed
   media-upload endpoint; confirm the upload succeeds and the stored object's
   size/etag match what a non-streamed re-upload of the same bytes produces.
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

7. **sqld under sustained multi-writer lease traffic.**
   Drive concurrent requests against the _same_ Durable-Object-backed
   resource id from both replicas simultaneously (e.g. `hey`/`ab` against a
   solid-pod resource path, or a small script firing concurrent writes at
   both `server1` and `server2` for the same id) for at least a minute;
   confirm no writes are lost or interleaved (the per-id lease serializes
   them — spec/scale-out.md §6.1) and sqld itself stays responsive
   throughout (no timeouts/connection resets in its logs).
   - [ ] **Pass** / [ ] **Fail** — notes: **************\_\_\_\_**************

### Step 2 — Hosted conformance suites against the ≥2-replica deployment

Per [host-contract.md §9](../spec/host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance),
central mode earns "supported" (rather than "experimental") only once the
suites relevant to whatever packages your composition mounts pass against
this ≥2-replica target — mirroring how the Node self-host target
(`targets.node`) already works in `conformance/status.json`, but with its
own `targets.central` slot per suite:

```bash
node scripts/conformance/run-suite.mjs <standard> \
  --target http://localhost:8000/<mount-path> --target-id central
```

`examples/central-composition.mjs` mounts WebFinger + IndieAuth + WebAuthn;
extend it (or point `--target` at your own composition's compose override)
to cover whichever suite you're recording. Record each suite run:

| Suite     | Target | Pass/Fail/Skip | Notes |
| --------- | ------ | -------------- | ----- |
| (fill in) |        |                |       |

- [ ] **Pass** — every exercised suite passes against `target-id: central`
- [ ] **Fail** — which suite(s) and why: **************\_\_\_\_**************

### Step 3 — Tear down

```bash
docker compose -f packages/server/docker-compose.yml down -v
```

The `-v` drops the named volumes (`sqld-data`, `minio-data`,
`replica{1,2}-scratch`) — this is a throwaway verification stack, not a
deployment to keep state in.

- [x] **Pass** — stack removed
- [ ] **Fail** — notes: **************\_\_\_\_**************

## Result

|                    |                                       |
| ------------------ | ------------------------------------- |
| Overall result     | ☐ Passing / ☐ Failing / ☐ Not yet run |
| Run date           |                                       |
| Tester             |                                       |
| sqld image tag     |                                       |
| MinIO image tag    |                                       |
| Notes / follow-ups |                                       |

## Recording the result

Central mode has no `status.json` package row of its own (`@dwk/server` is
private and unpublished, so it isn't subject to the release gate) — record
the result here, in the **Result** table above, and reference this doc's run
date from `spec/scale-out.md` §14/§15's "Update" notes the next time that
spec section is revised. If you extend the reference composition to mount a
publishable endpoint package and want that package's own conformance
suite(s) tracked against a `central` target, add a `targets.central` entry
next to that suite's existing `targets.node`/`targets.cloudflare` entries in
`conformance/status.json`, following the same shape.

## Troubleshooting

- **A replica keeps restarting** — central mode's fail-loud startup posture
  (spec/scale-out.md §9.2) means this is almost always sqld or MinIO not
  being ready yet when the replica's `probeCentralStores` ran; `docker
compose ... logs server1` will show a clear `StartupProbeError` naming
  which store failed, and `restart: unless-stopped` means it'll succeed on
  its own once the dependency is actually up — give it a few retry cycles
  before treating it as a real failure.
- **`ModeMarkerConflictError` on a fresh stack** — a leftover `sqld-data`
  volume from a previous run still has the `["dwk_meta", "mode"]` marker set
  from a different session; `docker compose ... down -v` before a fresh
  `up` clears it.
- **`aws4fetch` requests to MinIO fail with a signature mismatch** — confirm
  `DWK_S3_REGION`/`service: "s3"` are actually wired into whatever
  `AwsClient` construction your composition uses (see
  `examples/central-composition.mjs`'s comment on this — aws4fetch can't
  infer `service`/`region` from a non-`*.amazonaws.com` endpoint like
  MinIO's).
- **`docker compose build` fails resolving workspace packages** — the build
  context is the repo root (`context: ../..` in `docker-compose.yml`) and
  needs the full monorepo, same as the plain `Dockerfile`; a shallow/partial
  checkout won't build.
