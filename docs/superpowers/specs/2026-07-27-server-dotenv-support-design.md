# `@dwk/server` `.env` support: per-domain files + encryption

## Problem

`@dwk/server` is the one place in the repo allowed to read `process.env`
directly (the composition-root rule, `spec/composition-contract.md`), but it
has **no `.env`-file loading at all** today. Every composition module
(`examples/composition.mjs`, `examples/central-composition.mjs`) and the CLI
(`src/cli.ts`, `src/migrate.ts`) reads `process.env.*` straight from whatever
the process was launched with — there is no way to keep a deployment's
`DWK_BASE_URL`, `TOKEN_SIGNING_KEY`, S3/libSQL creds, etc. in a file next to
the composition module, and no supported way to keep that file's secrets
encrypted at rest.

Self-hosters running the `dwk-serve` bin directly (the secondary,
run-on-the-host path — Docker with `-e`/`--env-file` already covers the
primary path reasonably, though it can't decrypt anything) want:

1. A documented, comprehensive `.env.example` covering every var the host and
   its reference compositions already consume.
2. A `<domain>.env` naming convention so a box running (or a repo tracking
   config for) more than one dwk-serve deployment can keep each domain's
   config in its own file, picked up automatically.
3. `.env`/`<domain>.env` files reliably excluded from git.
4. A way to keep secrets in that file encrypted, not plaintext, for
   deployments that want the config file itself committed (e.g. to a private
   ops repo) or handled by a secrets-adjacent workflow.

## Non-goals

- Any change outside `@dwk/server`. Cloudflare-deployed packages keep getting
  config via `wrangler` vars/secrets; they never read `process.env` and this
  work doesn't touch that.
- Multi-domain **serving** (one process answering for several `baseUrl`s).
  `HostConfig.baseUrl` stays singular; this is only about which **file**
  supplies that single domain's config when the process starts.
- Reimplementing encryption. We depend on `@dotenvx/dotenvx` for both parsing
  and the `encrypted:`-value scheme rather than hand-rolling ECIES.
- Central-mode-specific env handling beyond what already exists — the new
  loader is orthogonal to `storage.mode`.

## Design

### 1. `loadDwkEnv()` (new module: `src/env.ts`)

```ts
export function loadDwkEnv(options?: { readonly cwd?: string }): void;
```

Resolution algorithm, run once at process startup, precedence high → low:
**real `process.env`** (already set before this runs) > **`<domain>.env`** >
**`.env`**. `<domain>.env` is never invented by this code — it only loads a
file that already exists in `cwd`.

1. `cwd = options?.cwd ?? process.cwd()`.
2. If `DWK_BASE_URL` is already present in the real environment (the common
   case: systemd `Environment=`, Docker `-e`, shell export — see
   `examples/dwk-serve.service`), derive `domain = new URL(DWK_BASE_URL).hostname`
   immediately.
3. Build `candidates`: `${domain}.env` (if `domain` is known and the file
   exists) first, then `.env` (if it exists). If `candidates` is non-empty,
   call `dotenvx.config({ path: candidates, quiet: true })` once. Without
   dotenvx's `overload` option, earlier paths in the array win over later
   ones, and anything already in `process.env` is left untouched — this gives
   us the precedence above in one call.
4. If `domain` was **not** known in step 2 (a self-contained setup where
   `DWK_BASE_URL` itself lives inside `.env`), re-read
   `process.env.DWK_BASE_URL` after step 3. If it's now set and a matching
   `${domain}.env` exists that wasn't already loaded, load it as an
   additional layer (`dotenvx.config({ path: "${domain}.env", quiet: true })`)
   so domain-specific secrets can still live alongside a shared `.env` that
   only sets the base URl.
5. No file present at all → no-op; existing behavior (each composition
   module's own `process.env.X ?? default` fallback) is unchanged.

This covers both real-world shapes without any special-casing beyond the two
branches above:

- **Systemd/Docker sets `DWK_BASE_URL` externally** → `<domain>.env` supplies
  the rest (secrets, data dir, S3/libSQL creds).
- **Fully self-contained** → a single `.env` (or a single `<domain>.env`, if
  the deployer names it that way from the start and exports nothing) has
  everything, `DWK_BASE_URL` included.

### 2. Wiring

- `main()` in `src/cli.ts` calls `loadDwkEnv()` automatically, before
  `loadConfig()`. This is the only place loading becomes implicit — it
  matches how dotenv-based CLIs conventionally behave, and `dwk-serve` is
  already the entry point that reads `$DWK_CONFIG`/`$PORT`/`$HOST` from the
  real environment, so adding a file-backed source ahead of it is consistent
  with what that entry point already does.
- `examples/serve.mjs` (the bundled Docker entry — this calls the composition
  factory directly, bypassing `main()` entirely) gains an explicit
  `loadDwkEnv()` call before `composition()` runs.
- `examples/composition.mjs` and `examples/central-composition.mjs` each gain
  the same explicit call at the top, as the documented pattern for a
  deployer's own composition module.
- `loadDwkEnv` is exported from the package's public entry point (`index.ts`)
  so a bespoke composition root can call it too.

### 3. Encryption (`@dotenvx/dotenvx`)

New pinned exact-version runtime dependency: `@dotenvx/dotenvx`. It replaces
nothing (there is no existing parser) and supplies both plain `KEY=VALUE`
parsing and transparent decryption of `encrypted:`-prefixed values — no
custom cryptography is written for this feature.

- **Generating**: `npx @dotenvx/dotenvx encrypt -f pod.example.com.env`
  rewrites plaintext values in that file to `encrypted:BASE64...` in place,
  inserts a `DOTENV_PUBLIC_KEY` line at the top of the file, and writes the
  matching private key into a local `.env.keys` file (created if absent,
  appended to otherwise).
- **Loading**: `loadDwkEnv()`'s `dotenvx.config()` call decrypts `encrypted:`
  values transparently, provided the matching `DOTENV_PRIVATE_KEY*` variable
  is present in the **real** environment at that point (systemd/Docker/secrets
  manager) — never inside the `.env`/`<domain>.env` file itself, and never in
  `.env.keys` once it leaves the machine that generated it.
- **Correction from the original draft of this spec** (confirmed by reading
  the pinned dependency's source, `src/lib/conventions/keynames.js`): dotenvx
  derives the private-key variable name from the **file's own embedded
  `DOTENV_PUBLIC_KEY[_X]` line** when one is present ("src public key name
  wins") — it does **not** recompute a name from the filename at load time.
  The filename only matters the _first_ time a file is encrypted (no
  `DOTENV_PUBLIC_KEY` line yet), and dotenvx's filename-derivation algorithm
  (`src/lib/conventions/environment.js`) assumes the `.env.<environment>`
  shape (dot-prefixed, single trailing label) — for a `<domain>.env` file
  (no leading dot, a multi-label domain), it does **not** produce a
  domain-meaningful suffix (e.g. `pod.example.com.env` yields
  `DOTENV_PUBLIC_KEY_COM_ENV`, and every `*.com.env` file collides on that
  same non-descriptive suffix). This is cosmetically confusing but not a
  correctness bug: since exactly one domain's file loads per `dwk-serve`
  process, whatever name got embedded in that file is the one name that
  process's real environment needs to supply, and `loadDwkEnv()` itself never
  computes or assumes a key name — it only needs the matching
  `DOTENV_PRIVATE_KEY*` to already be present in the real environment. The
  documented workflow (§4) is therefore: run `dotenvx encrypt`, then **read
  the exact key name dotenvx actually inserted** from the file's
  `DOTENV_PUBLIC_KEY*` line (or from `.env.keys`, which records the matching
  private key under the same name) rather than assume one — this is also how
  dotenvx's own docs instruct routine use, independent of our filename
  choice. `env.test.ts`'s encryption round-trip test follows this same
  read-don't-assume pattern rather than hardcoding a derived name.
- `.env.keys` is local-machine-only key material and must never be committed
  (see Gitignore below) or shipped inside a Docker image layer.

### 4. Documentation

- **`packages/server/.env.example`** (existing file, expanded — kept on the
  repo's established `.env.example` naming, not a new `example.env`) becomes
  the comprehensive reference: every var the host and its reference
  compositions consume (`DWK_BASE_URL`, `DWK_DATA_DIR`, `DWK_PUBLIC_DIR`,
  `DWK_CONFIG`, `PORT`, `HOST`, `TOKEN_SIGNING_KEY`, the central-mode
  S3/libSQL vars already documented ad hoc in `central-composition.mjs`), the
  `<domain>.env` precedence rules from §1, and the encryption section with the
  exact generate/encrypt commands from §3. Where a var already has a
  "how to generate a real value" example (e.g. `openssl rand -base64 32` for
  `TOKEN_SIGNING_KEY`), that example is preserved/extended, not replaced.
- **`README.md`** gains an "Environment files & secrets" section
  cross-linking `.env.example` and summarizing the precedence rule and the
  encrypt command.
- **`spec/self-hosting.md`** gains a new section recording this as a
  requirement (it is the authoritative spec for this package; there is no
  separate `spec/packages/server.md`).

### 5. Gitignore

Root `.gitignore`'s current exact-match `.env` (line 14) becomes `*.env`
(matches `<domain>.env` for any domain automatically; does not collide with
`.env.example`, which ends in `.example`, not `.env`), plus a new `.env.keys`
line for dotenvx's private-key store.

## Data flow

```
dwk-serve ./composition.mjs
  │
  ▼
main() (cli.ts)
  - registerCloudflareWorkers()
  - loadDwkEnv()                      ← NEW: resolves + loads env file(s)
  │     cwd has pod.example.com.env + .env
  │     DWK_BASE_URL already set (systemd) → domain known up front
  │     dotenvx.config({ path: ["pod.example.com.env", ".env"] })
  │     encrypted: values decrypted via whichever DOTENV_PRIVATE_KEY* name
  │     the file's own DOTENV_PUBLIC_KEY* line calls for (already present in
  │     the real environment, e.g. systemd Environment= — see §3)
  ▼
loadConfig(configPath)                ← unchanged: imports the config module
  ▼
composition()                         ← unchanged: reads process.env.* as before,
                                         now fully populated by the file(s) above
  ▼
startServer(config)
```

## Error handling

- Missing `.env`/`<domain>.env` files are not an error — `loadDwkEnv()` is a
  no-op when neither exists, matching today's "read `process.env` directly"
  behavior exactly.
- A malformed `.env`/`<domain>.env` file (dotenvx parse error) propagates as a
  startup failure from `main()`/the composition module — the existing
  fail-loud-at-startup posture (`MissingBindingError`, `InsecureBaseUrlError`)
  already establishes that a bad config surfaces before the server accepts
  traffic, not as a first-request 500.
- An `encrypted:` value with no matching private key present is dotenvx's own
  error surface — it propagates the same way (startup failure, not a silent
  pass-through of the ciphertext string into the app's config).

## Testing

- **`env.test.ts`** (new): the resolution/precedence algorithm against
  temp-dir fixtures —
  - only `.env` present → loaded.
  - only `<domain>.env` present (`DWK_BASE_URL` set externally) → loaded.
  - both present → `<domain>.env` values win, `.env` fills gaps.
  - neither present → no-op, `process.env` untouched.
  - real `process.env` value pre-set → never overwritten by either file.
  - `DWK_BASE_URL` known only via `.env` itself → the second-pass
    `<domain>.env` load still fires.
  - encrypt-then-decrypt round trip: a fixture file encrypted once with the
    real `dotenvx` CLI, private key supplied via a test-scoped env var,
    asserting the decrypted value reaches `process.env` — this also pins down
    the exact private-key variable name dotenvx expects for our filename
    shape (§3).
- **`cli.test.ts`**: `main()` calls `loadDwkEnv()` before `loadConfig()`,
  using the existing temp-cwd/env-restore pattern already used for
  `DWK_CONFIG`/`PORT` in that file.

## Open questions

None outstanding — scope, file-selection mechanism, parser/encryption
dependency choice, template filename, and CLI-vs-bundle auto-load behavior
were all confirmed with the repo owner during brainstorming. The one
implementation-time unknown (§3's exact private-key variable name for a
`<domain>.env`-shaped filename) is called out above and resolved by a test
against the real dependency, not left as a design ambiguity.
