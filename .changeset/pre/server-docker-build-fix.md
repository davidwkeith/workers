---
"@dwk/server": patch
---

Fix the self-host Docker image build. The builder ran `pnpm --filter @dwk/server
build`, which only compiles `@dwk/server` and not its workspace dependencies, so
`tsc` could not resolve `@dwk/log` (and the bundle's other `@dwk/*` deps had no
`dist`). It now runs `pnpm build` (all packages) before bundling. Verified by
building the image and running it end to end — boots, the WebAuthn Durable Object
answers through the aliased shim, and SIGTERM exits cleanly. Also drops the
`useradd --system` UID warning and adds a build-only `docker.yml` check on PRs
that touch the image inputs, so this can't regress (the workflow otherwise only
runs on release).
