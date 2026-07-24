---
"@dwk/server": minor
---

Packaging, migration tooling, and verification runbook for `central` storage
mode (spec/scale-out.md, phase 5 of the horizontal scale-out plan, #434).

- `dwk-migrate` — a second CLI bin (alongside `dwk-serve`, also exported as
  plain functions from `@dwk/server/migrate`) for mechanical local ↔ central
  data migration: D1/DO-SQLite dump-and-replay (dialect-identical, so it's a
  copy in either direction), streamed R2 object migration preserving
  content-type/custom metadata, pending-alarm lifting/lowering between a
  Durable Object's local SQLite file and the central coordination KV's
  due/by-id indexes (baked into every DO-object migration call, not a
  separate step to forget), and local queue backlog import into the
  coordination KV as due entries. `to-central` auto-discovers bindings by
  scanning `dataDir` the way `bindings.ts` lays it out; `to-local` takes an
  explicit target since central mode has no directory to list.
- `docker-compose.yml` — the sqld + MinIO + 2-replica reference deployment,
  doubling as the live-verification test bed; both replicas build from
  `examples/central-composition.mjs` via the existing `Dockerfile`
  (parameterized with a new `BUNDLE_ENTRY` build arg), fronted by an nginx
  proxy (`nginx.conf`) with WebSocket session affinity for whichever
  DO-WebSocket path a composition mounts.
- `k8s-notes.md` — the same topology's Kubernetes adaptation notes
  (`Deployment` vs `StatefulSet`, readiness/liveness probe shape, ingress
  session-affinity annotations, `emptyDir` scratch volumes for the
  embedded-replica cache).
- `conformance/scale-out-qa.md` — the fillable live-verification checklist
  (spec §14 item 4: libSQL read-your-writes/`batch` atomicity over hrana,
  embedded-replica forwarding under concurrent replicas, the `libsql` native
  module on the container base image, S3 read-after-write, streaming-body
  signing, sqld under sustained multi-writer lease traffic) and the hosted
  conformance run against a ≥2-replica target (item 5).
- README guidance ("Central mode: horizontal scale-out (experimental)") on
  when — and, more importantly, when *not* — to reach for central mode over
  the local-mode default, echoed with a one-line pointer from the repo root
  README.

Central mode remains **experimental, not supported** (host-contract §9)
until the live-verification checklist and hosted-suite run are actually
executed and recorded passing against real sqld/MinIO services — this phase
delivers the runbook and its test bed, not the run itself.
