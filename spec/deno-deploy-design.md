# Deno Deploy host — re-verification & design sketch (Phase 1 exploration)

> **Status: exploration — re-verification findings and a design sketch, nothing
> adopted.** This document answers the Phase 1 scope in
> [issue #383](https://github.com/davidwkeith/workers/issues/383): re-verify
> the Deno Deploy platform against
> [portability.md §4.1](portability.md#41-deno-deploy--the-credible-isolate-target)
> (a mid-2026 snapshot, now stale — see §1), and sketch the design for the
> gaps a `@dwk/deno-host` would need to close, evaluated against the
> normative [host-contract.md](host-contract.md). It commits to nothing: per
> #383 and [portability.md §5](portability.md#5-recommended-path), Phase 1 is
> explicitly demand-driven, and the **decision gate in §6 is a hold**, not a
> go.

## 1. Re-verification (2026-07-23 snapshot)

`portability.md` §4.1 evaluated **Deno Deploy Classic**: native `Deno.cron`,
native Deno Queues, and Deno KV with external (strong) consistency. That
platform is gone:

- **Deno Deploy Classic shut down on 2026-07-20** — three days before this
  re-verification — superseded by a rebuilt platform (Deno 2.0 runtime, new
  dashboard, integrated builds). The migration guide is the authoritative
  diff between the two.
- **`Deno.cron()` carries forward unchanged** — existing cron code needs no
  changes on the new platform. Host-contract §3.7 (cron) is still
  satisfiable.
- **Deno Queues are gone, with no built-in replacement.**
  `Deno.Kv.enqueue()` / `Deno.Kv.listenQueue()` are **not supported** on the
  new platform. Deno's own migration guidance is to adopt an external
  message queue service or build a database-backed job queue. This is a
  **new gap that did not exist when `portability.md` was written** — Classic
  had native queues, so the original §4.1 gap list (no SQLite, no
  single-writer primitive) never had to account for losing queues too.
- **Deno KV is available on the new platform and keeps the same consistency
  model**: strong by default (external consistency / serializability on
  writes and default-consistency reads), with an opt-in
  `consistency: "eventual"` relaxation per read, backed by a managed
  FoundationDB deployment. Existing Classic KV data is **not** carried over
  automatically. This part of the original analysis holds.
- **No native relational/SQL offering appeared.** The new platform's
  persistence story is Deno KV plus third-party Postgres providers wired in
  via environment variables — not a SQLite-compatible engine. Postgres
  cannot satisfy [host-contract.md §3.2/§3.5](host-contract.md#32-sqlstorage-durable-object-sqlite)
  as written (the packages issue raw SQLite dialect SQL, including
  `PRAGMA table_info(...)` migrations) without a translation layer, which
  the contract already treats as non-conforming. **The SQLite gap is
  unchanged from the original investigation.**
- **No native single-writer actor primitive appeared.** Same gap as before:
  serialized per-object access would still need to be built on Deno KV's
  atomic/compare-and-swap operations.
- **Execution model confirmed, and it rules out "just use local disk."** The
  new platform runs a **long-lived process per instance**, but **multiple
  instances of the same app run concurrently and share no disk, memory, or
  CPU** — horizontal scaling is instance-isolated by design. The new
  "file system write access" feature is per-instance scratch space, not a
  shared persistent volume, so it is not a candidate for authoritative
  state; it does not change the SQL-story conclusion above (an external
  strongly-consistent store is still required — the local-SQLite path
  `@dwk/server` uses does not transfer).
- **WebSockets remain supported** as a general platform capability (this
  predates and survives the Classic → new-platform cutover); host-contract
  §6's `WebSocketPair` requirement is a shim-design question layered on top
  of whichever instance holds the per-id lease (§3.2), not a
  platform-availability question — not sketched further here since §6
  recommends not proceeding yet.

**Net effect of re-verification:** the platform this investigation originally
scored is not the platform that exists today. The new platform is **harder to
target than Classic was**, not easier — it kept the two gaps the original
investigation already flagged (SQL, actor) and **added a third** (queues) that
Classic didn't have. Object storage was never scored in the original §4.1
table at all (the provider table's columns omit **O**/**Q** despite the
shorthand defining them) and needs its own line — see §3.4.

## 2. Updated feasibility verdict

| Gap | `portability.md` §4.1 (Classic) | This re-verification (new platform) |
| --- | --- | --- |
| Relational SQL (host-contract §3.2/§3.5) | Missing — needs external libSQL/Turso | **Unchanged** — still missing, same plausible design |
| Single-writer actor (host-contract §3.3) | Missing — needs a KV-lease design | **Unchanged** — still missing, same plausible design |
| Queues (host-contract §3.6) | **Present natively** (Deno Queues) | **Missing** — new gap, no built-in replacement |
| Object storage (host-contract §3.4) | Not scored | Missing — needs an R2-interface shim over an external object store |
| Cron (host-contract §3.7) | Present | **Present, unchanged** |
| WebSockets (host-contract §6) | Present | **Present, unchanged** |

`portability.md`'s verdict for Deno Deploy — "Feasible with significant
work... rough order: several weeks" — is now an **underestimate**. The
original estimate priced two gaps (SQL, actor); a conforming host needs to
close **four** (SQL, actor, queues, object storage). See §5.

## 3. Design sketch for each gap

Evaluated against the normative contract in
[host-contract.md](host-contract.md); nothing here is committed or built.

### 3.1 Relational SQL (`D1Database` / `SqlStorage`, host-contract §3.2, §3.5)

Unchanged from `portability.md` §4.1's original sketch: an external per-object
(for `SqlStorage`) or per-package (for `D1Database`) libSQL/Turso database,
wrapped to present the `prepare/bind/first/all/run/batch/exec` surface
host-contract §3.5 requires, and the synchronous-looking
`sql.exec`/`transactionSync` surface §3.2 requires for DO SQLite (libSQL's
client is async, so `transactionSync` would need to become a queued/awaited
wrapper — a real semantic gap from the "synchronous" contract wording, worth
flagging to host-contract maintainers if this is ever built, since "synchronous"
there encodes "the whole DO event loop blocks until commit," not literally a
synchronous JS call). This still reintroduces the third-party dependency
[portability.md §6](portability.md#6-open-questions) already flagged as an
open question against the project's "infrastructure the user owns" thesis —
**still unresolved, not addressed by this re-verification.**

> **Update (issue #397):** this shim is now implemented as the first
> increment of `@dwk/deno-host` (`packages/deno-host`; spec:
> [packages/deno-host.md](packages/deno-host.md)). The synchronous-surface
> gap resolved as anticipated above — `D1Database` wraps the async remote
> client directly, while `SqlStorage`/`transactionSync` take libSQL's
> synchronous **embedded-replica** client (the `libsql` package's
> better-sqlite3-compatible API), whose blocking write-forwarding is exactly
> the "whole DO event loop blocks until commit" semantics the contract
> encodes, so no host-contract text change was needed. §3.2–§3.4 remain
> unbuilt and the §6 gate still holds for them.

### 3.2 Single-writer actor (Durable Objects, host-contract §3.3)

Unchanged in shape from the original sketch: a lease per object id, built on
Deno KV's atomic/compare-and-swap operations (`Deno.Kv.atomic().check(...)`
gated on the lease key's `versionstamp`, `expireIn` for lease TTL). A request
arriving for an id acquires the lease (or is queued/retried at the edge if
held elsewhere), executes against the id's libSQL database (§3.1), and
releases or renews the lease. This satisfies host-contract §3.3 rule 1 (at
most one live instance per id) by construction, at the cost of added latency
per request (a KV round-trip to acquire the lease) that Cloudflare's
input-gate model and the Node host's in-process mutex don't pay.

**Alarms** (host-contract §3.3 rule 2): with no native per-object timer,
alarms would have to be emulated by storing the scheduled time in KV and
polling it from a `Deno.cron()` tick (§1 confirms cron survived the
platform cutover). This trades exact-time delivery for cron-tick-granularity
delivery — a real behavioral gap from Cloudflare's alarms and from
`@dwk/server`'s (exact, event-loop-timer-driven) emulation. `activitypub`
delivery retries and `atproto-pds` PLC-genesis retries — the two production
consumers of alarms — would need to tolerate that coarser granularity, or the
design needs a finer-grained polling loop running inside a long-lived
instance (in tension with §1's "instances come and go" execution model).

> **Update (issue #398, design finalized 2026-07-23):** the demand gate in
> §6 was overridden for this increment on a demonstrated demand signal (the
> rest of the plan — #399, #400 — stays gated). The full design (KV lease
> shape, alarm indexing, WebSocket handling, and the decision to make
> `pollAlarms` an exported tick function the composing app wires to its own
> `Deno.cron()` rather than a self-driving timer) is now written up in
> [packages/deno-host.md](packages/deno-host.md#design-single-writer-actor--alarm-emulation-issue-398);
> implemented. One refinement from the sketch above: alarm retries
> after a throwing handler are re-scheduled by writing a new KV due-index
> entry (picked up by whichever instance runs the next poll), not an
> in-process timer — the sketch's "instances come and go" tension applies to
> retry delivery too, not just the initial tick.

### 3.3 Queues (host-contract §3.6) — new gap

Since native queues are gone, a durable at-least-once queue would need to be
built on Deno KV directly: `queue.send(body)` writes an entry keyed by a
monotonic ordering prefix (e.g. `["queue", name, timestampNanos, uuid]`) with
an `attempts` counter starting at 0; a dispatcher — driven by the same
`Deno.cron()` tick as the alarm emulation in §3.2, since there is no
`listenQueue` equivalent to attach a consumer to — range-scans pending
entries, invokes the registered consumer, and on success deletes the entry
(`ack`) or on failure/throw reschedules it at `now + delaySeconds` with
`attempts` incremented (`retry`), matching host-contract §3.6's semantics.
This is a materially bigger lift than the original investigation scoped for
Deno Deploy at all (Classic didn't need it), and it sits on the **same**
cron-tick dispatcher as alarm emulation (§3.2) — so the design for "how often
does the tick run, and what does that cost in delivery latency for
`webmention`/`microsub`/`websub`" is now on the critical path for even the
**Tier 1** cohort (host-contract §9), not just Tier 2.

### 3.4 Object storage (`R2Bucket`, host-contract §3.4) — not previously scored

`portability.md`'s provider table never carried an **O** (object store)
column despite defining the shorthand, so Deno Deploy's object-storage story
was never assessed. Deno Deploy has no bundled equivalent; the plausible
design is a thin `R2Bucket`-shaped adapter over an external S3-compatible
provider (streaming `put`/`get`/`head`/`delete`, `httpMetadata` /
`customMetadata` round-tripped as S3 object metadata/content-type). Most
modern S3-compatible stores offer read-after-write consistency on a given
key, satisfying host-contract §3.4's requirement — but this is a **fourth**
external dependency (alongside the libSQL/Turso database and whatever queue
storage decision §3.3 lands on, though all three could in principle share
one provider's product suite), compounding the "infrastructure the user
owns" tension noted in §3.1.

> **Update (issue #400, implemented 2026-07-24):** the demand gate in §6
> was overridden for this increment, closing out the four gaps this
> document scoped — #397, #398, and #399 were already implemented; #400 was
> the last. The design landed as sketched above, with one refinement: rather
> than modeling `@aws-sdk/client-s3`'s `S3Client.send(Command)` surface (too
> large to reduce to a small structural seam the way `@libsql/client`'s or
> `Deno.Kv`'s do), the injected client seam is a single `fetch`-shaped
> method (`S3ClientLike`), which the composing app satisfies with an
> already-signing `fetch` — most naturally `aws4fetch`'s `AwsClient#fetch`
> bound to the provider's endpoint/region/credentials. This keeps the
> package itself dependency-free (only standard Web Platform APIs:
> `fetch`/`Headers`/`ReadableStream`/`TransformStream`) without taking on
> the AWS SDK as a dependency just to type the seam. Full design in
> [packages/deno-host.md](packages/deno-host.md#design-r2bucket-shaped-object-storage-adapter-issue-400).

## 4. Consistency analysis (host-contract.md §4)

| Store | Contract requirement | Design here |
| --- | --- | --- |
| DO SQLite (§3.2) | Serialized per id; `transactionSync` atomicity | KV lease (§3.2 sketch) serializes; libSQL transactions provide atomicity, but the sync-looking contract surface needs an async-to-sync-shaped wrapper (flagged as a real semantic gap, §3.1) |
| D1 (§3.5) | Read-your-writes; atomic `batch` | libSQL at the primary is read-your-writes for its own writer; `batch` maps to a libSQL transaction |
| R2 (§3.4) | Read-after-write | Depends on the chosen S3-compatible provider's per-key guarantee (§3.4) — provider-specific, not free |
| Queues (§3.6) | Durable, at-least-once | KV-backed dispatcher (§3.3) is durable (KV writes are durably replicated) and at-least-once by construction (delete-only-on-ack), but cron-tick-driven, not push-driven |

None of these are disqualifying the way Fastly's eventually-consistent KV
store is (`portability.md` §4.2) — Deno KV's default strong consistency is
the one piece of the original investigation's optimism that this
re-verification **confirms** rather than revises. The added cost is entirely
in **latency and build effort** (leases, polling dispatch, three external
dependencies), not in a fundamental consistency violation.

## 5. Revised effort estimate

`portability.md` priced Deno Deploy at "a real project (rough order: several
weeks)" against two gaps (SQL, actor). This re-verification found **four**
gaps (SQL, actor, queues, object storage), two of which (queues, the
cron-tick dispatcher they share with alarm emulation) are new discoveries,
not previously scoped work that simply needs polishing. A realistic estimate
is **materially larger than "several weeks"** — plausibly the same order of
effort as the entire `@dwk/cf-shims` extraction plus the Node host's DO/alarm
work (#379–#382), which was itself a multi-PR effort, **before** any
Deno-specific integration testing. This document does not attempt a precise
figure; the point is that the original estimate is stale and should not be
quoted going forward without this correction.

## 6. Decision gate

Per [issue #383](https://github.com/davidwkeith/workers/issues/383) and
[portability.md §5](portability.md#5-recommended-path), Phase 1 proceeds to a
real `@dwk/deno-host` package **only with demonstrated demand**. This
re-verification found:

- No new demand signal (this document is triggered by the issue's own
  "re-verify the platform first" instruction, not by a user request).
- The platform got **harder** to target since the original investigation,
  not easier — the Classic→new-platform cutover removed the one native
  capability (queues) that made Deno Deploy look closest to viable.

**Recommendation: hold.** Do not start a `@dwk/deno-host` package or attempt
the "run the stateless + D1-backed cohort" spike from #383's proposed scope
yet — attempting it today would immediately hit the queue gap (§3.3) for
`webmention`/`microsub`/`websub`, which host-contract's own Tier 1 definition
(host-contract.md §9) requires, so even the reduced "stateless-only" slice is
narrower than #383 assumed (effectively Tier 0 only:
`webfinger`/`host-meta`/pure libs — no queue-dependent endpoint package
qualifies without §3.3 first). Keep this design sketch as the reference if
demand appears, and re-run §1's platform check periodically — the new
platform is young and evolving (mirroring the same
"re-verify before committing" caution `portability.md` §4.1 already gave
about Classic).

> **Update (2026-07-24):** the gate was subsequently overridden, one
> increment at a time, on demonstrated demand signals specific to each
> (#397, then #398, then #399, then #400) — see each subsection's own
> "Update" callout above. All four gaps this document scoped are now
> implemented in `@dwk/deno-host`
> ([packages/deno-host.md](packages/deno-host.md)). This resolves "can a
> conforming `@dwk/deno-host` be built," not "should Phase 1 (a real,
> deployed Deno Deploy app) proceed" — that remains a separate decision, at
> the `portability.md` §5 level, still gated behind demonstrated demand for
> an actual deployment.

## 7. Open questions

- **Persistent local disk:** the new platform's "file system write access"
  is confirmed per-instance/non-shared (§1), but its documentation does not
  say whether it survives across requests *within* one long-lived instance
  lifetime, or resets per request. Immaterial to the authoritative-storage
  design above (§1 already rules out relying on it for state shared across
  instances) but worth confirming if a future design wants instance-local
  caching.
- **Cron tick granularity** on the new platform is not documented in what
  this investigation could reach; the queue (§3.3) and alarm (§3.2) designs'
  latency both depend on it directly.
- **Third-party dependency acceptability** — unchanged from
  [portability.md §6](portability.md#6-open-questions): is an external
  libSQL/Turso database (and now, per §3.4, an external S3-compatible object
  store too) acceptable for a project whose thesis is "data and keys live
  only on infrastructure the user owns"? This re-verification widens the
  dependency footprint from one external service to two or three; it does
  not resolve the question.
- **Where the queue/alarm dispatcher lives** — a `Deno.cron()` tick running
  in what instance, given §1's "instances come and go" model? This needs its
  own design pass if Phase 1 is ever greenlit; it is not sketched further
  here because §6 recommends not proceeding yet.

## 8. Reference links

- [portability.md](portability.md) — the original investigation this
  document re-verifies (§4.1 specifically); [host-contract.md](host-contract.md) —
  the normative contract every gap above is evaluated against;
  [self-hosting.md](self-hosting.md) — the first alternative host's design,
  the precedent for "emulate the binding interfaces, don't build a generic
  wrapper."
- [Deno Deploy migration guide](https://docs.deno.com/deploy/migration_guide/) —
  the Classic → new-platform diff, including the queues removal and the
  Deno KV migration note.
- [Deno Deploy runtime reference](https://docs.deno.com/deploy/reference/runtime/) —
  the long-lived, per-instance, no-shared-disk execution model (§1).
- [Deno KV on Deno Deploy](https://docs.deno.com/deploy/classic/kv_on_deploy/) /
  [Deno KV quick start](https://docs.deno.com/deploy/kv/) — consistency
  model and FoundationDB backing.
