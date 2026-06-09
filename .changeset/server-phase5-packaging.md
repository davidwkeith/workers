---
"@dwk/server": minor
---

Phase 5 packaging — make the host installable and runnable.

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
