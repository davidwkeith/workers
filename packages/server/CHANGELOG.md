# @dwk/server

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- b16323f: Add `assembleBindings(spec)` to `@dwk/server` — a declarative, package-agnostic
  helper that builds the shim-backed `Env` for a set of mounted packages under a
  deterministic data-directory layout (`d1/<NAME>.sqlite`, `r2/<NAME>/`,
  `kv/<NAME>.sqlite`) and injects secrets as plain `Env` members. It guards against
  binding names that are unsafe as path components and against two bindings
  colliding on the same `Env` key.

  This completes the Phase 2 self-hosting milestone (the D1/R2/KV storage MVP): the
  IndieWeb trio plus stateless discovery — `indieauth`, `micropub`, `webmention`,
  `webfinger`, `host-meta`, and `vc` — now mount and run end-to-end on
  `node:sqlite` + filesystem. A reference composition / acceptance test exercises
  authenticated DPoP-bound Micropub publishing, a media upload that lands on disk
  and serves back, the Webmention receiver (sync path) enqueuing verification, and
  WebFinger/host-meta resolution through the host.

- 35d4b0d: Phase 3 self-hosting: bring up the async/scheduled packages on the lifecycle
  shims.
  - Add `bindQueueConsumer` / `bindScheduledTask`: adapters that bind the
    assembled `Env` and a fresh waitUntil-tracked `ExecutionContext` to the
    Cloudflare-shaped `(batch|controller, env, ctx)` handlers the packages export,
    so they register with the in-process `QueueBroker` / `CronScheduler` and run
    unchanged. `HostConfig` gains an optional `tracker` so a consumer's/scheduled
    task's background work is drained on shutdown.
  - Add `installHTMLRewriter()` and call it from `createServer`: installs a
    WASM-backed, workerd-compatible `HTMLRewriter` global (the self-contained
    `@worker-tools/html-rewriter` base64 build — nothing fetched at runtime) so
    packages that scan HTML with the runtime's streaming rewriter
    (`@dwk/webmention` link verification, `@dwk/microsub` feed/`h-feed` discovery)
    run on Node.
  - A reference composition / acceptance test wires the real consumers and
    schedulers end-to-end on the shims: a Webmention is received and verified
    asynchronously into the inbox; a Microsub scheduled poll fans out and
    populates a channel timeline; a WebSub `distribute` job delivers an
    HMAC-signed payload to a subscriber; and the R2 GC cron reclaims an orphaned
    blob from the filesystem-R2 shim.

- 40376d2: Phase 4 (part) — Durable Object emulation, and bring up `@dwk/webauthn` on it.
  - Add a Node Durable Object emulation behind the `cloudflare:workers` boundary:
    `SqlStorage` over `node:sqlite` (the `sql.exec(...).one()/.toArray()` cursor),
    a `DurableObjectState` (`storage.sql` + `transactionSync` + `id` +
    in-memory `acceptWebSocket`/`getWebSockets`), the `DurableObject` base class,
    and a `DurableObjectNamespace` whose `get(id).fetch(req)` routes in-process to
    a singleton instance per id **serialised behind a per-id promise chain** —
    reproducing the single-writer guarantee. One SQLite file per object id under
    `<dataDir>/do/<className>/`.
  - Resolve the `cloudflare:workers` bare specifier (the packages' only runtime
    import from it, `{ DurableObject }`) to the shim: a `module.register` loader
    hook (`registerCloudflareWorkers`, for the `bin`) and a Vitest `resolve.alias`
    (tests), so `@dwk/webauthn` / `@dwk/solid-pod` / `@dwk/activitypub` run
    unchanged from source/dist.
  - Add `installRequestDuplex()` (called from `createServer`): defaults Node's
    `Request` `duplex: "half"` for streaming-body requests, so the packages'
    DO sub-request forwarding (`new Request(url, { body: request.body })`) — valid
    on workerd — works on Node.
  - Bring up `@dwk/webauthn` end-to-end through the host on the emulated per-RP DO
    (registration/authentication challenge ceremonies), plus unit tests for the DO
    emulation (SqlStorage, per-id serialisation under concurrency, per-id state
    isolation, stable ids).

  `@dwk/solid-pod` (LDP/WAC/N3-patch over the same DO machinery, with authz) and
  WebSocket-backed Solid notifications are the remaining Phase 4 work.

- f1f7acc: Complete Phase 4 self-hosting: bring up `@dwk/solid-pod` on the emulated Durable
  Object, including WebSocket notifications.
  - `@dwk/solid-pod` now runs end-to-end through the host on the Node DO emulation:
    LDP create/read/`If-Match`/delete, Solid N3 Patch, WAC (owner allowed,
    non-owner `403`, anonymous `401`), and opaque blob bodies streamed through R2 —
    all driven over real HTTP through `createServer`.
  - WebSocket hibernation is emulated so Solid notification channels work on Node:
    a `WebSocketPair` of linked in-memory sockets, a `Response` that carries a
    `webSocket` + `101` status (both of which Node's `Response` otherwise rejects),
    and a `webSocketMessage`/`webSocketClose` bridge from the DO state. The host
    bridges real client WebSockets to the matching mount's DO over an HTTP
    `upgrade` via the `ws` library, so a subscriber receives change notifications
    when a resource is written. Adds `ws` as a dependency.

  With this, every `@dwk` package — stateless, D1/R2-backed, queue/cron, and
  Durable Object — runs on the self-hosting host.

- b9af330: Phase 5 packaging — make the host installable and runnable.
  - **`dwk-serve` bin / CLI**: `dwk-serve ./composition.js [--port] [--host]` (or
    `$PORT`/`$HOST`/`$DWK_CONFIG`) loads a composition-root config module, registers
    the `cloudflare:workers` loader hook, `createServer` + `listen`s, and wires
    SIGTERM/SIGINT graceful shutdown. `loadConfig` / `startServer` / `parseArgs` /
    `createShutdown` are exported (via `@dwk/server/cli`) for embedding.
  - **Single-file bundle** (`scripts/bundle.mjs`, esbuild): bundles a composition
    entry + the `@dwk` packages it uses into one ESM file, **aliasing
    `cloudflare:workers` to the Node Durable-Object shim at build time** so the
    bundle needs no loader hook.
  - **Docker image** (the primary self-host artifact): a multi-stage `Dockerfile`
    builds the bundle and ships it on a minimal Node 24 image — non-root, a `/data`
    volume, and a healthcheck. A reference `systemd` unit and a runnable example
    composition (`examples/`) accompany it.
  - **Security / docs**: the host already refuses a non-localhost `http://`
    `baseUrl` outside dev mode (identity is HTTPS-rooted); the README documents the
    TLS-at-a-proxy, DDoS, SSRF (LAN blast radius), `0700` data-dir, and
    data-portability (D1 ⇄ SQLite, R2 ⇄ filesystem, DO-SQLite ⇄ per-id file) posture.

  The package stays experimental until a Node conformance column lands in
  `conformance/status.json` and versioned image tags are published.

- 409a864: Add `@dwk/server` — a Node.js/Express self-hosting host for the `@dwk` packages.

  It is the Node analogue of "the Worker entry + `wrangler.toml`" a Cloudflare
  deployer writes by hand: it composes the endpoint factories, bridges Express
  `(req, res)` ⇄ Web `Request`/`Response` (streaming both ways), serves static
  files alongside the endpoints with deterministic routing precedence (reserved
  protocol paths win over static files), and constructs the `Env` from Node-backed
  shims for the Cloudflare binding interfaces so the endpoint packages run
  unchanged — mirroring how `@dwk/store` confines Cloudflare storage.

  This first cut covers the host skeleton + adapter + static hosting, the storage
  shims (`D1Database` → `node:sqlite`, `R2Bucket` → filesystem, `KVNamespace` →
  SQLite/memory), and the lifecycle shims (`waitUntil` tracking, an in-process
  SQLite-backed durable Queue with retry/backoff/dead-letter, and a cron/
  `scheduled` timer) — enough to self-host the stateless and D1/R2-backed packages.
  Correctness is at least as strong as the Cloudflare target (a single Node process
  over local SQLite is strictly serializable), guarded by a single-writer
  lockfile. Durable Object emulation and the Docker image / CLI follow.

  Requires Node ≥ 22 (the SQLite shim uses the built-in `node:sqlite`).

### Patch Changes

- 959f738: Track the self-hosted Node host as its own conformance target. `conformance/status.json`
  (and its schema) gain a per-target dimension: a top-level `targets` declaration
  (`cloudflare` primary, `node` self-host) and an optional `targets` map on each
  suite/integration block, plus an `@dwk/server` package row. The release gate now
  validates every declared target for stable packages, the report shows the Node
  column, and `run-suite.mjs --target-id node` records hosted results into it. The
  Node host's integration lifecycle is recorded `passing` for the packages the
  `@dwk/server` integration tests bring up end to end; a `docker.yml` workflow
  builds/publishes the image on release. `@dwk/server` stays experimental until its
  hosted conformance column is green.
- 4d28881: Fix the self-host Docker image build. The builder ran `pnpm --filter @dwk/server
build`, which only compiles `@dwk/server` and not its workspace dependencies, so
  `tsc` could not resolve `@dwk/log` (and the bundle's other `@dwk/*` deps had no
  `dist`). It now runs `pnpm build` (all packages) before bundling. Verified by
  building the image and running it end to end — boots, the WebAuthn Durable Object
  answers through the aliased shim, and SIGTERM exits cleanly. Also drops the
  `useradd --system` UID warning and adds a build-only `docker.yml` check on PRs
  that touch the image inputs, so this can't regress (the workflow otherwise only
  runs on release).
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
