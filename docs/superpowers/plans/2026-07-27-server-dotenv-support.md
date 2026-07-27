# `@dwk/server` `.env` support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@dwk/server` full `.env` support — a `loadDwkEnv()` helper that
loads `<domain>.env` (derived from `DWK_BASE_URL`'s hostname) and/or `.env`
into `process.env`, wired into the CLI and reference compositions, backed by
`@dotenvx/dotenvx` for both plain parsing and `encrypted:`-value decryption,
plus a comprehensive `.env.example`, docs, and gitignore coverage.

**Architecture:** One new module, `packages/server/src/env.ts`, wraps
`@dotenvx/dotenvx`'s `config()` with a two-branch domain-resolution algorithm.
`dwk-serve`'s CLI (`main()`) calls it automatically; bundled/reference
composition modules call it explicitly since they bypass `main()`. No other
package is touched — `@dwk/server` is the only place in the repo allowed to
read `process.env`.

**Tech Stack:** TypeScript (strict, `NodeNext` modules), Vitest, `@dotenvx/dotenvx@2.19.0`.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-27-server-dotenv-support-design.md` — read it before starting; every task below implements one of its sections.
- **Scope:** `packages/server` only. No other `@dwk/*` package changes.
- **Dependencies minimized and pinned to exact versions** (repo-wide rule, `CLAUDE.md`) — `@dotenvx/dotenvx` is pinned to the exact version `2.19.0`, no `^`/`~`.
- **ESM-only, `.d.ts` shipped, strict TypeScript** — `import type` for type-only imports, prefix deliberately-unused vars with `_`.
- **Composition-root rule:** `@dwk/server` is the one place in the repo allowed to read `process.env` directly; this feature does not change that boundary, it only adds a file-backed source the composition root can opt into.
- **Precedence, high to low (do not deviate):** real `process.env` (already set before `loadDwkEnv()` runs) > `<domain>.env` > `.env`. Missing files are silently skipped, never an error.
- **Conventional Commits** for every commit message in this plan: `<type>(server): <subject>`.
- All five CI gates (lint → format:check → typecheck → build → test) must pass locally before considering this plan done; run `pnpm test --project @dwk/server`, `pnpm --filter @dwk/server typecheck`, and `pnpm --filter @dwk/server build` after each task touching code.

---

### Task 1: `loadDwkEnv()` core — dependency, module, precedence tests

**Files:**
- Modify: `packages/server/package.json` (add `@dotenvx/dotenvx` dependency)
- Create: `packages/server/src/env.ts`
- Create: `packages/server/src/env.test.ts`

**Interfaces:**
- Produces: `loadDwkEnv(options?: LoadDwkEnvOptions): void` and `interface LoadDwkEnvOptions { readonly cwd?: string }`, both from `packages/server/src/env.ts` — later tasks (3, 4) import `loadDwkEnv` from this file (and, after Task 3, from `@dwk/server`'s `index.ts` re-export).

- [ ] **Step 1: Add the pinned dependency**

Edit `packages/server/package.json`'s `"dependencies"` block — it currently
reads:

```json
  "dependencies": {
    "@dwk/cf-shims": "workspace:*",
    "@dwk/deno-host": "workspace:*",
    "@dwk/log": "workspace:*",
    "express": "5.2.1",
    "helmet": "8.3.0",
    "ws": "8.21.1"
  },
```

Change it to (alphabetical, `@dotenvx` sorts before `@dwk`):

```json
  "dependencies": {
    "@dotenvx/dotenvx": "2.19.0",
    "@dwk/cf-shims": "workspace:*",
    "@dwk/deno-host": "workspace:*",
    "@dwk/log": "workspace:*",
    "express": "5.2.1",
    "helmet": "8.3.0",
    "ws": "8.21.1"
  },
```

Then install:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing precedence tests**

Create `packages/server/src/env.test.ts`:

```ts
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDwkEnv } from "./env.js";

const STATIC_KEYS = [
  "DWK_BASE_URL",
  "FOO",
  "SECRET",
  "SHARED",
  "DOMAIN_ONLY",
  "GENERIC_ONLY",
  "PRESET",
  "A",
  "B",
] as const;

let saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function snapshot(): void {
  saved = {};
  for (const key of STATIC_KEYS) saved[key] = process.env[key];
}

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-env-"));
  dirs.push(dir);
  return dir;
}

function writeEnvFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

afterEach(() => {
  for (const key of STATIC_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadDwkEnv", () => {
  it("loads a plain .env when no domain is known", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(dir, ".env", "FOO=bar\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.FOO).toBe("bar");
  });

  it("loads <domain>.env when DWK_BASE_URL is already set", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SECRET=xyz\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.SECRET).toBe("xyz");
  });

  it("prefers <domain>.env over .env for overlapping keys, and fills gaps from .env", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SHARED=domain\nDOMAIN_ONLY=d\n");
    writeEnvFile(dir, ".env", "SHARED=generic\nGENERIC_ONLY=g\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.SHARED).toBe("domain");
    expect(process.env.DOMAIN_ONLY).toBe("d");
    expect(process.env.GENERIC_ONLY).toBe("g");
  });

  it("is a no-op when neither file exists", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    expect(() => loadDwkEnv({ cwd: dir })).not.toThrow();
    expect(process.env.FOO).toBeUndefined();
  });

  it("never overwrites a real pre-set process.env value", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    process.env.PRESET = "real-value";
    const dir = workdir();
    writeEnvFile(dir, ".env", "PRESET=file-value\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.PRESET).toBe("real-value");
  });

  it("loads <domain>.env as a second pass when DWK_BASE_URL is only known via .env", () => {
    snapshot();
    delete process.env.DWK_BASE_URL;
    const dir = workdir();
    writeEnvFile(
      dir,
      ".env",
      "DWK_BASE_URL=https://blog.example.org\nA=from-generic\n",
    );
    writeEnvFile(dir, "blog.example.org.env", "B=from-domain\n");
    loadDwkEnv({ cwd: dir });
    expect(process.env.DWK_BASE_URL).toBe("https://blog.example.org");
    expect(process.env.A).toBe("from-generic");
    expect(process.env.B).toBe("from-domain");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test --project @dwk/server env.test`
Expected: FAIL — `Cannot find module './env.js'` (the module doesn't exist yet).

- [ ] **Step 4: Implement `loadDwkEnv()`**

Create `packages/server/src/env.ts`:

```ts
/**
 * Loads `<domain>.env` and/or `.env` into `process.env` via
 * `@dotenvx/dotenvx` (parsing + `encrypted:`-value decryption).
 * `@dwk/server` is the one place in the repo allowed to read the
 * environment (spec/composition-contract.md); this is a small helper the
 * composition root calls before it does.
 *
 * Precedence, high to low: real `process.env` (already set before this
 * runs) > `<domain>.env` (`<domain>` is the hostname of `DWK_BASE_URL`) >
 * `.env`. Missing files are silently skipped — dotenvx's default
 * (non-strict) behavior already tolerates a missing path without throwing,
 * so no existence check is needed here.
 *
 * @see spec/self-hosting.md §9
 */
import { config as dotenvxConfig } from "@dotenvx/dotenvx";
import { join } from "node:path";

/** Options for {@link loadDwkEnv}. */
export interface LoadDwkEnvOptions {
  /** Directory to look for `.env` / `<domain>.env` in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** The hostname of `baseUrl`, or `undefined` if unset or unparseable. */
function domainFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Load the given paths via dotenvx, throwing on any non-ignored error. */
function load(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const result = dotenvxConfig({
    path: [...paths],
    quiet: true,
    ignore: ["MISSING_ENV_FILE"],
  });
  if (result.error) throw result.error;
}

/**
 * Load `<domain>.env` (derived from `DWK_BASE_URL`'s hostname, if known) and
 * `.env` from `cwd`, in that precedence. Safe to call whether or not either
 * file exists.
 */
export function loadDwkEnv(options: LoadDwkEnvOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const path = (name: string): string => join(cwd, name);

  const domain = domainFromBaseUrl(process.env.DWK_BASE_URL);
  load(domain ? [path(`${domain}.env`), path(".env")] : [path(".env")]);

  // DWK_BASE_URL wasn't known externally — it may have just been set by the
  // .env loaded above. Check again, and layer in a matching <domain>.env
  // that wasn't already part of the first load.
  if (!domain) {
    const discovered = domainFromBaseUrl(process.env.DWK_BASE_URL);
    if (discovered) load([path(`${discovered}.env`)]);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test --project @dwk/server env.test`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @dwk/server typecheck && pnpm lint && pnpm format:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/env.ts packages/server/src/env.test.ts
git commit -m "feat(server): add loadDwkEnv() for .env / <domain>.env loading"
```

(This is a pnpm workspace — only the root `pnpm-lock.yaml` exists; there is
no per-package lockfile.)

---

### Task 2: Encryption support — round-trip test against the real `dotenvx` CLI

**Files:**
- Modify: `packages/server/src/env.test.ts`

**Interfaces:**
- Consumes: `loadDwkEnv` from `./env.js` (Task 1).
- Produces: nothing new — this task is verification only, confirming
  `loadDwkEnv()` needs no code changes to support encrypted values (dotenvx's
  `config()` already decrypts transparently; see design spec §3 for why the
  private-key variable name is read from the file, never assumed).

- [ ] **Step 1: Write the failing encryption tests**

Add to the bottom of `packages/server/src/env.test.ts` (extend the imports at
the top first):

```ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
```

Add a module-scope constant (near the other top-level constants) resolving
the installed `dotenvx` CLI script directly, so the test never depends on a
global install or network access:

```ts
const require = createRequire(import.meta.url);
const dotenvxCli = join(
  require.resolve("@dotenvx/dotenvx/package.json"),
  "..",
  "src/cli/dotenvx.js",
);

function encryptFile(dir: string, filename: string): void {
  execFileSync(
    "node",
    [dotenvxCli, "encrypt", "-f", filename, "--no-armor", "--no-native"],
    { cwd: dir },
  );
}

/** Extra env vars set mid-test (dynamic key names dotenvx assigns) to clean up. */
const dynamicKeys: string[] = [];
```

Extend the existing `afterEach` to also clean up `dynamicKeys`:

```ts
afterEach(() => {
  for (const key of STATIC_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const key of dynamicKeys.splice(0)) delete process.env[key];
});
```

Add the two new tests inside the `describe("loadDwkEnv", ...)` block:

```ts
  it("decrypts encrypted: values using whichever DOTENV_PRIVATE_KEY* name dotenvx assigns", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(
      dir,
      "pod.example.com.env",
      "PLAIN=not-secret\nSECRET_VALUE=super-secret\n",
    );
    encryptFile(dir, "pod.example.com.env");

    // Read back whichever DOTENV_PUBLIC_KEY* name dotenvx actually assigned —
    // never assume one (see design spec §3: filename-derived naming isn't
    // meaningful for <domain>.env files).
    const encryptedFile = readFileSync(
      join(dir, "pod.example.com.env"),
      "utf8",
    );
    const publicKeyMatch = encryptedFile.match(/^(DOTENV_PUBLIC_KEY\w*)=/m);
    expect(publicKeyMatch).not.toBeNull();
    const privateKeyName = publicKeyMatch![1].replace("PUBLIC", "PRIVATE");

    const keysFile = readFileSync(join(dir, ".env.keys"), "utf8");
    const privateKeyMatch = keysFile.match(
      new RegExp(`^${privateKeyName}=(.+)$`, "m"),
    );
    expect(privateKeyMatch).not.toBeNull();

    process.env[privateKeyName] = privateKeyMatch![1];
    dynamicKeys.push(privateKeyName);

    loadDwkEnv({ cwd: dir });
    expect(process.env.PLAIN).toBe("not-secret");
    expect(process.env.SECRET_VALUE).toBe("super-secret");
  });

  it("throws when an encrypted value has no matching private key available", () => {
    snapshot();
    process.env.DWK_BASE_URL = "https://pod.example.com";
    const dir = workdir();
    writeEnvFile(dir, "pod.example.com.env", "SECRET_VALUE=super-secret\n");
    encryptFile(dir, "pod.example.com.env");
    // No DOTENV_PRIVATE_KEY* in the real environment, and no .env.keys to
    // fall back to: decryption must fail loudly, not silently pass the
    // ciphertext through as the app's config value.
    rmSync(join(dir, ".env.keys"));
    expect(() => loadDwkEnv({ cwd: dir })).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test --project @dwk/server env.test`
Expected: the two new tests exist and either pass immediately (if the
implementation already handles this — likely, since Task 1's `loadDwkEnv`
already just forwards to `dotenvx.config()`) or fail with a clear assertion
mismatch. If they fail, inspect the mismatch — the design spec's analysis
(confirmed empirically against `@dotenvx/dotenvx@2.19.0`'s source during
brainstorming) says no code change should be needed; if one of these two
tests fails, that means this pinned version's behavior differs from what was
verified — re-read `node_modules/@dotenvx/dotenvx/src/lib/main.js`'s `config`
function and `src/lib/conventions/keynames.js` to see what changed before
touching `env.ts`.

- [ ] **Step 3: Confirm both tests pass**

Run: `pnpm test --project @dwk/server env.test`
Expected: PASS (8 tests total in this file).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/env.test.ts
git commit -m "test(server): verify loadDwkEnv() decrypts dotenvx-encrypted values"
```

---

### Task 3: Wire into the CLI and the package's public exports

**Files:**
- Modify: `packages/server/src/cli.ts`
- Modify: `packages/server/src/cli.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `loadDwkEnv` from `./env.js` (Task 1).
- Produces: `loadDwkEnv` re-exported from `@dwk/server`'s public entry point
  (`index.ts`) — Task 4's example modules import it from there.

- [ ] **Step 1: Write the failing CLI test**

In `packages/server/src/cli.test.ts`, add `writeFileSync` is already
imported; add `rmSync` if not already (it is not currently imported — check
the existing import line and extend it):

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

(This import already exists verbatim in the file — no change needed there.)

Add a new test inside the `describe("main", ...)` block, after the existing
"parses args, loads the config path, and starts listening" test:

```ts
    it("loads a domain .env file before reading the config", async () => {
      const dir = workdir();
      const path = join(dir, "config.mjs");
      writeFileSync(
        path,
        `export default {
    baseUrl: process.env.DWK_BASE_URL,
    dataDir: ${JSON.stringify(dir)},
    env: {},
    lock: false,
    mounts: [
      {
        name: "ping",
        reservedPaths: ["/ping"],
        handler: async () => new Response("pong"),
      },
    ],
  };`,
      );
      writeFileSync(
        join(dir, ".env"),
        `DWK_BASE_URL=http://localhost\n`,
      );
      const prevBaseUrl = process.env.DWK_BASE_URL;
      delete process.env.DWK_BASE_URL;
      const prevCwd = process.cwd();
      process.chdir(dir);
      const cap = capture();
      try {
        const server = await main({
          argv: [path, "--port", "0", "--host", "127.0.0.1"],
          logger: cap.logger,
          signals: false,
        });
        try {
          const port = portFrom(cap);
          expect(port).toBeGreaterThan(0);
        } finally {
          await server.close();
        }
      } finally {
        process.chdir(prevCwd);
        if (prevBaseUrl === undefined) delete process.env.DWK_BASE_URL;
        else process.env.DWK_BASE_URL = prevBaseUrl;
      }
    });
```

Add the `join` import needed above — check the top of `cli.test.ts`: `join`
is already imported (`import { join } from "node:path";`). No change needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --project @dwk/server cli.test`
Expected: FAIL — the config module reads `process.env.DWK_BASE_URL`, which is
`undefined` (deleted above and not yet loaded from `.env`), so the exported
config's `baseUrl` is `undefined`. `loadConfig`'s own runtime check
(`typeof (config as HostConfig).baseUrl !== "string"`, `cli.ts`) rejects that
with `did not produce a valid HostConfig`, so `await main(...)` rejects and
the test fails with that error instead of reaching the `port` assertion.

- [ ] **Step 3: Wire `loadDwkEnv()` into `main()`**

In `packages/server/src/cli.ts`, add the import:

```ts
import { loadDwkEnv } from "./env.js";
```

(alongside the existing imports at the top of the file). Then, in `main()`,
call it right after `registerCloudflareWorkers()`:

```ts
export async function main(options: MainOptions = {}): Promise<DwkServer> {
  const { configPath, port, host } = parseArgs(
    options.argv ?? process.argv.slice(2),
  );
  // Redirect `cloudflare:workers` to the Node shim before the config — and the
  // Durable-Object packages it imports — are dynamically loaded.
  registerCloudflareWorkers();
  loadDwkEnv();
  const config = await loadConfig(configPath);
  const { server } = await startServer(config, {
    port: port ?? options.port,
    host: host ?? options.host,
    logger: options.logger,
    signals: options.signals,
  });
  return server;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --project @dwk/server cli.test`
Expected: PASS.

- [ ] **Step 5: Run the full `@dwk/server` suite to check for regressions**

Run: `pnpm test --project @dwk/server`
Expected: PASS — in particular, re-check the pre-existing `main` tests
("parses args, loads the config path, and starts listening",
"registers SIGTERM/SIGINT handlers...") still pass; they run from the
repo/package's real cwd, which has no `.env`/`<domain>.env` file, so
`loadDwkEnv()` is a no-op for them.

- [ ] **Step 6: Export `loadDwkEnv` from the package's public surface**

In `packages/server/src/index.ts`, add a new export block. Insert it after
the existing `export { toWebRequest, sendWebResponse } from "./adapter.js";`
line (around line 44):

```ts
export { loadDwkEnv, type LoadDwkEnvOptions } from "./env.js";
```

- [ ] **Step 7: Typecheck and build**

Run: `pnpm --filter @dwk/server typecheck && pnpm --filter @dwk/server build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/cli.ts packages/server/src/cli.test.ts packages/server/src/index.ts
git commit -m "feat(server): load <domain>.env / .env automatically in dwk-serve's main()"
```

---

### Task 4: Wire explicit `loadDwkEnv()` calls into the reference compositions

**Files:**
- Modify: `packages/server/examples/composition.mjs`
- Modify: `packages/server/examples/central-composition.mjs`
- Modify: `packages/server/examples/serve.mjs`

**Interfaces:**
- Consumes: `loadDwkEnv` exported from `@dwk/server` (Task 3, Step 6).

These files aren't unit-tested directly by `@dwk/server`'s own test suite in
a way that exercises `.env` loading (they're illustrative reference
compositions), so this task's verification is: the package still builds, and
the existing integration tests that import these modules
(`bundle.integration.test.ts` for `serve.mjs`/`composition.mjs`) still pass —
`loadDwkEnv()` is a no-op in CI since no `.env`/`<domain>.env` file exists in
those test working directories.

- [ ] **Step 1: Add the call to `composition.mjs`**

In `packages/server/examples/composition.mjs`, add the import at the top and
the call as the first line of the `composition()` function body:

```js
import {
  assembleBindings,
  createDurableObjectNamespace,
  loadDwkEnv,
} from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createWebAuthn, WebAuthnObject } from "@dwk/webauthn";

/** Build the HostConfig from the environment (the composition root reads env). */
export default function composition() {
  loadDwkEnv();
  const baseUrl = process.env.DWK_BASE_URL ?? "http://localhost";
  const dataDir = process.env.DWK_DATA_DIR ?? "./data";
  // ... (rest of the function is unchanged)
```

- [ ] **Step 2: Add the call to `central-composition.mjs`**

In `packages/server/examples/central-composition.mjs`, add `loadDwkEnv` to
the existing `@dwk/server` import and call it before the first
`process.env` read:

```js
import {
  assembleCentralBindings,
  createCentralDurableObjectNamespace,
  createCentralServer,
  CentralFleetPoller,
  LibsqlKv,
  loadDwkEnv,
} from "@dwk/server";
```

Then, immediately after the imports (before `const baseUrl = ...`):

```js
loadDwkEnv();
```

- [ ] **Step 3: Add the call to `serve.mjs`**

In `packages/server/examples/serve.mjs`, add the import and call before
`composition()` runs:

```js
import { startServer, loadDwkEnv } from "@dwk/server/cli";
import composition from "./composition.mjs";
```

Wait — `loadDwkEnv` is exported from `@dwk/server`'s root entry (`index.ts`),
not `@dwk/server/cli`. Use two import statements instead:

```js
import { startServer } from "@dwk/server/cli";
import { loadDwkEnv } from "@dwk/server";
import composition from "./composition.mjs";

const write = (stream) => (event, fields) =>
  stream.write(
    `dwk-serve ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`,
  );

const logger = {
  debug: () => {},
  info: write(process.stdout),
  warn: write(process.stderr),
  error: write(process.stderr),
};

loadDwkEnv();
startServer(composition(), { logger }).catch((err) => {
  process.stderr.write(`dwk-serve: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the affected integration test**

Run: `pnpm test --project @dwk/server bundle.integration`
Expected: PASS — these tests build/run the bundle from a temp dir with no
`.env` files present, so `loadDwkEnv()` no-ops and behavior is unchanged.

- [ ] **Step 5: Run the full `@dwk/server` build to make sure the examples still typecheck/bundle**

Run: `pnpm --filter @dwk/server build && pnpm --filter @dwk/server bundle packages/server/examples/serve.mjs`
Expected: no errors, bundle produced at `packages/server/dist-bundle/dwk-serve.mjs`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/examples/composition.mjs packages/server/examples/central-composition.mjs packages/server/examples/serve.mjs
git commit -m "feat(server): call loadDwkEnv() explicitly in reference compositions"
```

---

### Task 5: Expand `.env.example`

**Files:**
- Modify: `packages/server/.env.example`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Replace the file with the comprehensive reference**

The current file (5 vars, docker-compose-central-mode-only scope) becomes the
full reference for every var the host and its example compositions consume,
plus the `<domain>.env` convention and encryption workflow. Replace
`packages/server/.env.example` entirely with:

```sh
# Reference environment file for @dwk/server (self-hosting). Copy this to
# `.env` (loaded from the current working directory) or to `<domain>.env`
# (e.g. `pod.example.com.env` — the hostname of DWK_BASE_URL) for a
# per-domain file, and edit. See "How files are chosen" below.
#
# `dwk-serve`'s CLI loads this automatically before reading your config
# module. A bundled/Docker composition (examples/serve.mjs,
# examples/composition.mjs, examples/central-composition.mjs) calls
# `loadDwkEnv()` from `@dwk/server` explicitly at the top instead, since it
# bypasses the CLI entirely — see spec/self-hosting.md §9.
#
# ---------------------------------------------------------------------------
# How files are chosen (precedence, high to low):
#
#   1. Real process environment (systemd `Environment=`, Docker `-e`, shell
#      export) — never overridden by either file below.
#   2. `<domain>.env`, where `<domain>` is the hostname of DWK_BASE_URL —
#      picked up automatically once DWK_BASE_URL is known, whether that's
#      because it's already in the real environment, or because a plain
#      `.env` (below) just set it.
#   3. `.env` — shared/generic defaults, or (for a single-domain setup) the
#      one file with everything, DWK_BASE_URL included.
#
# A missing file at either level is not an error — it's simply skipped.
# ---------------------------------------------------------------------------

# Public origin the deployment is reached at. Identity is HTTPS-rooted — the
# host refuses a non-localhost `http://` value outside dev mode. Put a
# TLS-terminating reverse proxy (Caddy/nginx/Traefik) in front for anything
# beyond local testing.
DWK_BASE_URL=https://pod.example.com

# Root directory for SQLite databases, R2-on-disk objects, and the writer
# lock. Defaults to `./data` in the reference compositions.
DWK_DATA_DIR=./data

# Directory of static files (the user's website), served after endpoints.
# Optional — omit to run endpoints only, with no static site.
DWK_PUBLIC_DIR=./public

# Path to your composition-root config module. Only read by the `dwk-serve`
# bin when no path is given as a CLI argument. Defaults to ./dwk.config.js.
DWK_CONFIG=./composition.mjs

# TCP port / bind interface for `dwk-serve`. Defaults to 3000 / all interfaces.
PORT=3000
HOST=0.0.0.0

# Example secret consumed by `examples/composition.mjs` when it mounts
# @dwk/indieauth: signs IndieAuth tokens. Generate a real value with:
#   openssl rand -base64 32
TOKEN_SIGNING_KEY=dev-signing-key-change-me

# --- Central mode only (spec/scale-out.md; experimental, see README.md
#     "Central mode") — read by examples/central-composition.mjs. Leave
#     unset for the default, recommended local-mode single-process setup.
DWK_LIBSQL_URL=
DWK_LIBSQL_AUTH_TOKEN=
DWK_S3_ACCESS_KEY_ID=dwk-minio
DWK_S3_SECRET_ACCESS_KEY=dwk-minio-secret
DWK_S3_REGION=us-east-1

# ---------------------------------------------------------------------------
# Encryption (optional): keep a domain's secrets in this file at rest without
# committing them in plaintext, via @dotenvx/dotenvx (a dependency of
# @dwk/server, so no separate install is needed to *decrypt* — encrypting
# uses its CLI via `npx`).
#
# 1. Write your real values into `<domain>.env` (or `.env`) in plaintext,
#    same as the vars above.
# 2. Encrypt the file in place:
#
#      npx @dotenvx/dotenvx encrypt -f pod.example.com.env
#
#    This rewrites each value to `encrypted:BASE64...`, inserts a
#    `DOTENV_PUBLIC_KEY[_X]` line at the top of the file, and writes the
#    matching `DOTENV_PRIVATE_KEY[_X]` into a new/updated `.env.keys` file
#    next to it.
#
# 3. IMPORTANT — read, don't assume, the exact key variable name: open the
#    encrypted file and look at its `DOTENV_PUBLIC_KEY...=` line; the
#    matching private-key variable is the same name with PUBLIC → PRIVATE.
#    (dotenvx derives this suffix from the filename the *first* time it
#    encrypts a file; for a `<domain>.env`-shaped name — as opposed to
#    dotenvx's own `.env.<environment>` convention — that suffix is not
#    domain-meaningful, e.g. `pod.example.com.env` may get
#    `DOTENV_PUBLIC_KEY_COM_ENV`. That's fine: exactly one domain's file
#    loads per `dwk-serve` process, so the name only needs to be correct for
#    that one process, not memorable across domains.)
# 4. `.env.keys` is private-key material — never commit it (see the repo's
#    root .gitignore) and never ship it inside a container image. For local
#    development, leaving `.env.keys` next to the encrypted file is enough —
#    dotenvx reads it automatically when the matching `DOTENV_PRIVATE_KEY*`
#    isn't already in the real environment. For production, inject the
#    private key value as a real environment variable instead (systemd
#    `Environment=`, Docker `-e`, or your secrets manager), under the exact
#    name from step 3, and don't ship `.env.keys` at all.
```

- [ ] **Step 2: Prettier check**

Run: `pnpm format:check`
Expected: no errors (this file isn't a format target for Prettier's default
extensions, but confirm the command still passes cleanly for the rest of the
repo — no unrelated formatting drift was introduced).

- [ ] **Step 3: Commit**

```bash
git add packages/server/.env.example
git commit -m "docs(server): expand .env.example to cover <domain>.env and encryption"
```

---

### Task 6: README + spec documentation

**Files:**
- Modify: `packages/server/README.md`
- Modify: `spec/self-hosting.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Add a README section**

In `packages/server/README.md`, insert a new `## Environment files & secrets`
section immediately before the existing `## Security (you now own what
Cloudflare provided)` heading:

```markdown
## Environment files & secrets

`dwk-serve`'s CLI loads `<domain>.env` (the hostname of `DWK_BASE_URL`) and/or
`.env` from the current working directory automatically, before reading your
config module — real environment variables (systemd `Environment=`, Docker
`-e`) always win over either file, and a domain-specific file wins over the
generic one. A bundled/Docker composition calls the same `loadDwkEnv()`
helper (exported from `@dwk/server`) explicitly at the top of its own module,
since it bypasses the CLI entirely.

See [`.env.example`](./.env.example) for every supported variable, the file
precedence rules, and how to encrypt a file's values at rest with
`npx @dotenvx/dotenvx encrypt` — decryption happens transparently via the
same `loadDwkEnv()` call, given the matching `DOTENV_PRIVATE_KEY*` in the real
environment (never committed).
```

- [ ] **Step 2: Add a spec section**

In `spec/self-hosting.md`, extend the existing `## 9. Configuration &
secrets` section (do not renumber — insert new content at the end of that
section, before the `## 10. Distribution & CLI` heading):

```markdown

### 9.1 `.env` / `<domain>.env` loading (implemented, #<issue>)

`@dwk/server` exports `loadDwkEnv()` (`src/env.ts`), the one file-backed
config source the composition root may opt into. Precedence, high to low:
real `process.env` (already set before it runs) > `<domain>.env` (`<domain>`
is the hostname of `DWK_BASE_URL`) > `.env`; missing files are silently
skipped. `dwk-serve`'s CLI calls it automatically before loading the config
module; the bundled Docker entry and reference compositions
(`examples/serve.mjs`, `examples/composition.mjs`,
`examples/central-composition.mjs`) call it explicitly, since they bypass the
CLI.

Parsing and `encrypted:`-value decryption are both delegated to
`@dotenvx/dotenvx` (a pinned exact-version dependency) rather than
implemented in-house — no custom cryptography. `packages/server/.env.example`
is the full reference: every supported variable, the file-selection rules
above, and the encrypt/decrypt workflow.
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/README.md spec/self-hosting.md
git commit -m "docs(server): document .env / <domain>.env loading and encryption"
```

---

### Task 7: Gitignore coverage

**Files:**
- Modify: `.gitignore`

**Interfaces:** None.

- [ ] **Step 1: Broaden the `.env` pattern**

In the root `.gitignore`, the current line 14 reads:

```
.env
```

Replace it with:

```
# dwk-serve .env / <domain>.env files (packages/server/.env.example,
# spec/self-hosting.md §9.1) — real secrets, never committed. Does not match
# .env.example (that ends in .example, not .env).
*.env
# dotenvx private-key store (packages/server/.env.example) — never commit.
.env.keys
```

- [ ] **Step 2: Verify the pattern behaves as intended**

Run:

```bash
cd packages/server
touch pod.example.com.env .env.keys
git check-ignore -v pod.example.com.env .env.keys .env.example
rm -f pod.example.com.env .env.keys
```

Expected: `pod.example.com.env` and `.env.keys` both print a match against
the new `.gitignore` lines; `.env.example` prints nothing (exit code 1, not
ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore <domain>.env files and dotenvx's .env.keys"
```

---

### Task 8: Changeset

**Files:**
- Create: `.changeset/server-dotenv-support.md`

**Interfaces:** None.

- [ ] **Step 1: Write the changeset**

Create `.changeset/server-dotenv-support.md`:

```markdown
---
"@dwk/server": minor
---

Add full `.env` support: `loadDwkEnv()` loads `<domain>.env` (the hostname of
`DWK_BASE_URL`) and/or `.env` from the working directory, with real
environment variables always winning over either file and a domain-specific
file winning over the generic one. `dwk-serve`'s CLI calls it automatically;
the bundled Docker entry and reference compositions call it explicitly.

Parsing and `encrypted:`-value decryption are provided by a new pinned
dependency, `@dotenvx/dotenvx` — no custom cryptography. `.env.example` is
expanded into the full reference (every supported variable, the file
precedence rules, and the encrypt/decrypt workflow via
`npx @dotenvx/dotenvx encrypt`), and the root `.gitignore` now covers any
`<domain>.env` file and dotenvx's `.env.keys` private-key store.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/server-dotenv-support.md
git commit -m "chore(server): add changeset for .env support"
```

---

## Final verification

- [ ] Run the full local CI gate for the package: `pnpm --filter @dwk/server lint && pnpm --filter @dwk/server run build && pnpm test --project @dwk/server`
- [ ] Run the repo-wide gate once: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test --project @dwk/server`
- [ ] Confirm `git log --oneline` shows one commit per task above, in order.
