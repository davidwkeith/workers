# Kubernetes notes for central mode

`docker-compose.yml` in this directory is the reference deployment and the
[live-verification](../../conformance/scale-out-qa.md) test bed; it is not a
Kubernetes manifest. These are the adaptation notes spec/scale-out.md §15
phase 5 calls for — what changes (and what doesn't) moving the same topology
onto a real orchestrator. Nothing here is a tested, ready-to-apply manifest;
treat it as a checklist for writing your own.

## What doesn't change

The topology is identical to `docker-compose.yml`: sqld (or managed Turso) +
an S3-compatible object store + N identical `@dwk/server` replicas behind an
ingress. Every replica runs the same image, built the same way
(`docker build -f packages/server/Dockerfile --build-arg
BUNDLE_ENTRY=<your composition> .`); nothing about the container image is
Kubernetes-specific.

## Deployment shape

- **`Deployment`**, not `StatefulSet`. Replicas are stateless and
  interchangeable (spec/scale-out.md §4) — no replica has an identity another
  replica needs to inherit, so ordinary rolling-update `Deployment` semantics
  are exactly right. A `StatefulSet`'s per-pod stable identity/ordered
  rollout buys nothing here and only makes scaling more awkward.
- **Readiness probe**: point it at the mode-marker/store round-trip check
  central mode already does at startup (`probeCentralStores`,
  spec/scale-out.md §9.2) — expose it as an HTTP endpoint in your own
  composition (`createCentralServer` doesn't wire one automatically today)
  and wire `readinessProbe.httpGet` to it, cached for a few seconds so it
  isn't a full round-trip on every kubelet tick (§12's "readiness endpoint"
  operational note).
- **Liveness probe**: a plain "process is up and the HTTP listener accepts
  connections" check (`GET /` is enough, same shape as the Dockerfile's own
  `HEALTHCHECK`) — do **not** reuse the readiness probe's store round-trip
  here; a liveness probe that can fail because sqld is briefly unreachable
  will kill and restart a perfectly healthy replica instead of just pulling
  it from the Service's endpoints, which is what readiness is for.
- **`restart`/pod restart policy**: central mode's fail-loud startup posture
  (§9.2 — exit non-zero rather than serve 500s) is exactly what Kubernetes'
  default `restartPolicy: Always` expects; no special casing needed, unlike
  the docker-compose file's explicit `restart: unless-stopped` (Compose
  doesn't default to always-restart the way a Pod spec does).

## WebSocket session affinity (spec/scale-out.md §6.4)

A live socket (Solid notifications, the atproto firehose — whichever
DO-WebSocket package your composition mounts) is pinned to the replica that
terminated the upgrade; central mode's v1 posture handles this
operationally, not architecturally (§6.4). On Kubernetes:

- **`Service` with `sessionAffinity: ClientIP`** gets you affinity at the
  Service/kube-proxy layer, but it's coarse — it pins by client IP for
  _every_ request from that client, not just the WebSocket path, and breaks
  down behind a NAT/shared egress IP (many clients look like one). Prefer
  this only if your ingress can't do path-scoped affinity.
- **An ingress controller with cookie-based affinity on the specific
  WebSocket path** (e.g. NGINX Ingress's
  `nginx.ingress.kubernetes.io/affinity: cookie` annotation, scoped to the
  `Ingress` rule for `/notifications` or `/firehose`) is the closer analogue
  to this package's own `nginx.conf` (`ip_hash` on an upstream scoped to that
  one `location`) — only the socket path gets pinned, ordinary requests still
  load-balance freely.
- Either way this is the same documented v1 limitation, not a gap specific
  to Kubernetes: a replica holding a lease can go stale relative to another
  replica's write while the socket stays open, bounded to "stale-but-safe
  notifications" (§6.4). If that window is unacceptable for your deployment,
  pin the DO-WebSocket-heavy mount to a single-replica `Deployment`
  (`replicas: 1`) and scale the stateless cohort separately, or wait for the
  v2 residency design (§6.5).

## Scratch volumes for `replicaDir`

`DWK_REPLICA_DIR` (the embedded-replica cache, spec/scale-out.md §6.2) is a
**rebuildable cache**, not authoritative state — sync-before-serve
(§6.2's non-optional rule) means a fresh, empty `replicaDir` is always
correct, just slower on the very first request per object id after a cold
start. On Kubernetes:

- An `emptyDir` volume (no `medium: Memory` needed unless you specifically
  want it to be tmpfs-backed) is sufficient and matches the compose file's
  ephemeral named volume — it disappears with the pod, which is exactly
  right for a cache.
- Do **not** use a `PersistentVolumeClaim` for this — there is nothing to
  persist, and a PVC bound to one node would reintroduce the single-node
  pinning central mode exists to remove.
- Size it to the working set of DO objects a replica actually serves
  concurrently, not the total dataset (each id's embedded-replica file is
  small — see spec/scale-out.md §6.2's "one libSQL server hosts many
  databases" framing); a few hundred MB is a reasonable starting request/limit
  for most deployments, tune from observed usage.

## sqld and the object store

Neither is part of this Kubernetes checklist's scope in detail — both are
"exactly two centralized services" (spec/scale-out.md §4) that can be:

- **Managed**: Turso (for sqld) and any S3-compatible provider (R2, S3,
  Backblaze B2, DigitalOcean Spaces) — no Kubernetes objects needed for
  these at all, just endpoint/credential secrets injected into the
  Deployment's env.
- **Self-hosted in-cluster**: sqld as its own single-replica `Deployment` (or
  `StatefulSet` if you want a stable network identity for a future
  replicated-sqld topology — out of scope here, §11.3's sharding lever is
  the relevant follow-on) with a `PersistentVolumeClaim` for `/var/lib/sqld`
  (this **is** authoritative state, unlike `replicaDir` above); MinIO
  similarly, or its own Helm chart if you want its full distributed-erasure-
  coding mode rather than the compose file's single-node instance.

## Secrets

`DWK_TOKEN_SIGNING_KEY`, `DWK_S3_ACCESS_KEY_ID`/`DWK_S3_SECRET_ACCESS_KEY`,
and any sqld auth token belong in a Kubernetes `Secret`, mounted as env vars
exactly like the compose file's `.env` — nothing about central mode changes
how secrets are injected (spec/composition-contract.md's "config is
injected, the host is the composition root" still holds; only the mechanism
supplying the values differs).
