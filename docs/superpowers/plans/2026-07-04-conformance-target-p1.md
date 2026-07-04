# Conformance Target (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `packages/conformance-target` — a private Worker package composing all 14 endpoint packages behind `conformance.dwk.io` — with a Miniflare smoke test, deploy CI job, and the litmus runbook, so hosted conformance suites finally have a target.

**Architecture:** One Worker with a first-match-wins mount table routing path prefixes to each package's `createX(config)` handler. `ConformanceEnv` is the union of every package's `Env` fragment (expressed as `interface ConformanceEnv extends …` so TypeScript proves the union composes). All env→config translation happens in one file (`config.ts`); packages never read env directly. The WebDAV door gets its **own pod** at `baseUrl = ${origin}/dav` (the per-pod DO is keyed by `idFromName(resolved.baseUrl)`, so same-pod dual-door mounting needs verb dispatch — deliberately deferred to the Solid phase, P4; a dedicated litmus pod is protocol-valid and simpler).

**Tech Stack:** TypeScript strict, vitest + `@cloudflare/vitest-pool-workers` (workerd), wrangler (deploy), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-04-conformance-target-design.md`

## Global Constraints

- pnpm 10, Node >= 20 locally; CI uses Node 24.
- Prettier: semicolons, double quotes, trailing commas (`all`), 80-column width. Run `pnpm format` before every commit; `pnpm format:check` is a CI gate.
- TypeScript strict via `tsconfig.base.json`: `verbatimModuleSyntax` (use `import type` for type-only imports), `noUncheckedIndexedAccess`, `noUnusedLocals`/`Parameters`.
- ESM only; internal deps as `"workspace:*"`.
- The composition contract: packages MUST NOT read global env; this package is exactly the env→config seam. Missing bindings fail loudly (each package already asserts its own).
- `compatibilityDate: "2025-01-01"` + `compatibilityFlags: ["nodejs_compat"]` everywhere (matches `packages/solid-pod/vitest.config.ts`; N3.js needs Node built-ins).
- Conventional commits, scope `conformance-target`.
- All commands run from the repo root.
- The vitest project is auto-discovered (`packages/*/vitest.config.ts` glob) — no root config edits needed. Same for pnpm workspace and ESLint.

## Key facts discovered during research (trust these over guesses)

- Every endpoint factory has the shape `createX(config): (request, env, ctx) => Promise<Response>` with non-generic `Request`/`ExecutionContext` from `@cloudflare/workers-types`.
- Binding names are **fixed inside packages**: `AUTH_DB` + `TOKEN_SIGNING_KEY` (indieauth, shared by micropub/microsub), `MICROPUB_DB` + `MEDIA`, `MICROSUB_DB` + `MICROSUB_QUEUE`, `WEBMENTION_QUEUE` + `WEBMENTION_INBOX`, `WEBSUB_DB` + `WEBSUB_QUEUE`, `POD` + `BLOBS` + `GC_DB` (solid-pod), `STORAGE` + `BLOBS` + `GC_DB` (remotestorage), `ACTOR` (activitypub), `WEBAUTHN` (webauthn), `VC_SIGNING_KEY` (vc), `REPO` + `BLOBS` (atproto-pds). `BLOBS`/`GC_DB` are therefore **shared** bindings across storage packages — one bucket, one D1. That is safe: `@dwk/store`'s GC only collects orphan rows recorded in `GC_DB` (never a bucket sweep), and atproto blobs (keyed by CID) never enter `GC_DB`.
- DO classes to re-export and declare: `SolidPodObject` (`@dwk/solid-pod`), `RemoteStorageObject` (`@dwk/remotestorage`), `ActivityPubObject` (`@dwk/activitypub`), `WebAuthnObject` (`@dwk/webauthn`), `AtprotoRepoObject` (`@dwk/atproto-pds`).
- Queue consumers: `createWebmentionQueueConsumer(config)` (`@dwk/webmention`), `createWebSubQueueConsumer(config)` (`@dwk/websub`), `createMicrosubQueueConsumer(config)` (`@dwk/microsub`). Job types `WebmentionJob`, `WebSubJob` are exported; if `MicrosubJob` is not exported from `@dwk/microsub`, type that branch's batch as `Parameters<MicrosubQueueConsumer>[0]` instead.
- Scheduled GC: `createSolidPodGc(config): (event: ScheduledController, env, ctx) => Promise<void>`. solid-pod and remotestorage share the `@dwk/store` GC schema and the same `BLOBS`/`GC_DB` bindings, so **one** collector pass covers both.
- The pod DO is keyed `env.POD.idFromName(resolved.baseUrl)` (`packages/solid-pod/src/handler.ts:223,270,333`) — Solid door, WebDAV door, and credentials door hit the same pod only when configured with the **same `baseUrl`**.
- ActivityPub actor IRI is `${baseUrl}/users/${username}` (`packages/activitypub/src/config.ts:217-227`); nodeinfo at `/.well-known/nodeinfo` + `/nodeinfo/2.x`. `ActorProfile.username` is the required field (`packages/activitypub/src/as2.ts:132`).
- IndieAuth requires an `approveAuthorization(request: AuthorizationRequest, httpRequest: Request) => Promise<AuthorizationApproval | Response>` hook; returning a `Response` renders it (our consent form), returning `{ me }` mints the code.
- `SolidPodConfig.authenticate?: (request) => AuthContext | null` overrides token verification; `AuthContext = { webid, jti, jkt }`. We use it for a shared-secret admin bearer (interim until the P4 Solid-OIDC spike).
- Release gate: 0.x packages are exempt, but every package gets a `conformance/status.json` entry by convention (`@dwk/server` precedent).

## File Structure

```
packages/conformance-target/
  package.json            # private, version 0.0.0, deps on all endpoint packages
  tsconfig.json           # typecheck (noEmit), paths to workspace deps
  tsconfig.build.json     # build to dist/, excludes tests + harness
  vitest.config.ts        # workerd project with ALL bindings + test secrets
  wrangler.jsonc          # deploy config: DOs, R2, D1, queues, cron, custom domain
  README.md               # one-time setup + deploy + litmus runbook
  src/
    config.ts             # ConformanceEnv union + configsFor(env): all package configs
    approval.ts           # IndieAuth consent form + password check
    home.ts               # test identity: h-card root page + WebID profile card
    mounts.ts             # Mount table + router
    index.ts              # Worker entry: fetch/queue/scheduled + DO re-exports
    test-harness.ts       # vitest pool entrypoint (excluded from build)
    smoke.test.ts         # per-mount smoke tests
```

Modified files: `conformance/status.json` (new entry), `.github/workflows/conformance.yml` (deploy job), `conformance/README.md` + `spec/conformance-and-testing.md` (target pointer), `CLAUDE.md` (package count).

---

### Task 1: Package scaffold + Env union

**Files:**
- Create: `packages/conformance-target/package.json`
- Create: `packages/conformance-target/tsconfig.json`
- Create: `packages/conformance-target/tsconfig.build.json`
- Create: `packages/conformance-target/vitest.config.ts`
- Create: `packages/conformance-target/src/config.ts`
- Create: `packages/conformance-target/src/test-harness.ts`
- Create: `packages/conformance-target/src/index.ts` (minimal; grows in Task 2/6)
- Modify: `conformance/status.json` (add entry)

**Interfaces:**
- Produces: `ConformanceEnv` (the union Env), `configsFor(env)` returning `{ webfinger, hostMeta, indieauth, micropub, microsub, webmention, websub, activitypub, remotestorage, solidPod, davPod, webauthn, vc, atproto }` config objects, `ownerWebId(env)`. Later tasks import these from `./config.js`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@dwk/conformance-target",
  "version": "0.0.0",
  "private": true,
  "description": "Conformance-target Worker: every @dwk endpoint package composed into one deployable Worker (conformance.dwk.io) that the hosted conformance suites run against. Never published.",
  "type": "module",
  "license": "ISC",
  "author": "David W. Keith <me@dwk.io>",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@dwk/activitypub": "workspace:*",
    "@dwk/atproto-pds": "workspace:*",
    "@dwk/host-meta": "workspace:*",
    "@dwk/indieauth": "workspace:*",
    "@dwk/micropub": "workspace:*",
    "@dwk/microsub": "workspace:*",
    "@dwk/remotestorage": "workspace:*",
    "@dwk/solid-pod": "workspace:*",
    "@dwk/vc": "workspace:*",
    "@dwk/webauthn": "workspace:*",
    "@dwk/webfinger": "workspace:*",
    "@dwk/webmention": "workspace:*",
    "@dwk/websub": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "4.20260620.1"
  }
}
```

Note: no `files`/`publishConfig` — the package is never published. `@dwk/webdav` is not a direct dep (its doors are re-exported through `@dwk/solid-pod`). Check the repo root `package.json`/lockfile for whether `wrangler` is already a root devDependency; if not, add `"wrangler"` (latest 4.x, exact-pinned like other deps) to **this package's** devDependencies so `pnpm --filter @dwk/conformance-target deploy` works.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "paths": {
      "@dwk/activitypub": ["../activitypub/src/index.ts"],
      "@dwk/atproto-pds": ["../atproto-pds/src/index.ts"],
      "@dwk/host-meta": ["../host-meta/src/index.ts"],
      "@dwk/indieauth": ["../indieauth/src/index.ts"],
      "@dwk/micropub": ["../micropub/src/index.ts"],
      "@dwk/microsub": ["../microsub/src/index.ts"],
      "@dwk/remotestorage": ["../remotestorage/src/index.ts"],
      "@dwk/solid-pod": ["../solid-pod/src/index.ts"],
      "@dwk/vc": ["../vc/src/index.ts"],
      "@dwk/webauthn": ["../webauthn/src/index.ts"],
      "@dwk/webfinger": ["../webfinger/src/index.ts"],
      "@dwk/webmention": ["../webmention/src/index.ts"],
      "@dwk/websub": ["../websub/src/index.ts"]
    },
    "types": [
      "@cloudflare/workers-types",
      "@cloudflare/vitest-pool-workers/types"
    ],
    "noEmit": true
  },
  "include": ["src"]
}
```

If any mapped package has secondary exports the compiler complains about (e.g. `@dwk/ldn/discovery` pulled in transitively), copy the extra `paths` lines from `packages/solid-pod/tsconfig.json`.

- [ ] **Step 3: Write `tsconfig.build.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"],
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/test-harness.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

The test keys below are throwaway material generated for this plan — safe to commit, never used in production (production keys are Worker secrets).

```typescript
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Throwaway RSA keypair for the ActivityPub actor under test. */
const AP_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyfrPaMG2hvVZ8E1yMZFO
dsD5kuKNq1pCUePObQMZB7rHr5tVI15GAt4hW2hdWaNcxjxiZo2TJxl3cEtdC4RS
8zMX1Pav34gC2kd49ioo76qfOU+Wl2VR9Ykw775c3fJcvHIEKRi34au1vPRW0Vp6
i5oGfz9LFmBcm0ry0QVb3NB6tpbzECFbtaJ29zX7Oqk2ck/stgBHJs8Q3wN+OjwQ
TaLSzMt5mNsmTWJIo9PEJ+eRIqSv6pF4XHMUYLceLL8+VyQrG42rRR07pQv4B9hQ
sYsBHcXWDVnopyyhD+/wry7dpAj/YRAPNKXjxjbSgwp3aX0xKP+yBNQ5enuA8tVb
OQIDAQAB
-----END PUBLIC KEY-----`;

const AP_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJ+s9owbaG9Vnw
TXIxkU52wPmS4o2rWkJR485tAxkHusevm1UjXkYC3iFbaF1Zo1zGPGJmjZMnGXdw
S10LhFLzMxfU9q/fiALaR3j2Kijvqp85T5aXZVH1iTDvvlzd8ly8cgQpGLfhq7W8
9FbRWnqLmgZ/P0sWYFybSvLRBVvc0Hq2lvMQIVu1onb3Nfs6qTZyT+y2AEcmzxDf
A346PBBNotLMy3mY2yZNYkij08Qn55EipK/qkXhccxRgtx4svz5XJCsbjatFHTul
C/gH2FCxiwEdxdYNWeinLKEP7/CvLt2kCP9hEA80pePGNtKDCndpfTEo/7IE1Dl6
e4Dy1Vs5AgMBAAECggEAA0qfDqn5e4GMEapxbfVcPfsvFgGzJVO3OPZpasVeJw4Y
KvhxDr5+jZVpHcA5pThQTrq1L86m00BK/f18aq+hWm0+ui269/2TblMz2W8ec6lo
JtrxLU5tY3702TNU+Bj3AespvjG07WyK7aVdtNOwo43DBVfWtWqkl7NE+bsIoDSO
GtrzvwE7ZWbkw0/w1hYYlqV/HLuHnWnI0Zl3KgeFTlJOJ1jMWnl0drqA8fuhNSZO
PuRBZrwEEMPicW2KfDh87FDtviLzEKkq3O8fDTRgS/WvjXLXycfXy9Ko52fecMSD
Bveb0qostiiC8Cv8kkWvFXdqmp6Yv3G7IFmf1gLKAQKBgQD4I7g2yTzvjGBoE2aV
NMb+ORc+n6j1Gfl6sUZ5LeclIpBCMgpLu1+YgH9hxXG/cyqQ4L6zE4l2NtULJHLH
NKJgUgzLLvGJKTkmoLXTld+4LN+lqBgjtdPnU92aiGioMHYKF9YbN3QXb7+kVDOG
rpyNw85WEWfzZLbM41TfFkqGSQKBgQDQYMJOgSULpk/r2CLHVbhZmoT2a//8faMx
pvVn7QGphzXtNlToDAfLHqHIEgU1awb5QkH2XtdlrNIASqcd+kbHxlNJIxh9SduR
KEuZV0MFvbjlvA49N/iu8tcASA/zAlQzjXwM2JdSxoYa2NzEGOwmQV5Ms5bv/nEu
unJVPqttcQKBgHyd67jP7aNcO1ppS95pB/rKjyrrIf4d0lXUy9C1xdy3c/1ahiMs
ccDz34UplIuSefESfZMPn7xXozyaTG5Qt69p5XTxGWpJ4qLMmSQuo5EqMBNQzPa6
LTaCvssJ8I1u8Qj2mZdHjSzr+TG8+7eK36KukGRXD36DuO5CyO/UkQ7JAoGAR1vL
Tq0FLa8fkWlrx42AWxcCT4z+lc3ElB1Tzuon9pE6E2jWvLxZ8uIjjus0420qbzOU
eTVTWBtNsxHdlvN9R66QGOyu10Dyswv0j6eFaTLmXa3/xlEjlW3N2OfUpmh2w0zB
XXjSoWMgy5LWT0UloZgjHesmVjtxMQpiWvTiKdECgYEAwqfrhjqZF74OpKk78RSn
Kw5KFDZz4v5JfYvTbjs+9GPO4Ftb/pNP1X8bpA6hkE4mqqG7+vjAWgd2hjU3XLum
Az5N7HxMxBwO8D2zdaKL+/zoaE/12O7Vaa3ajp9uOx0xyavrzKr7m3l0sZOF2Ylc
S3IBQZi/trRtr2NQCd56ErE=
-----END PRIVATE KEY-----`;

/** Throwaway P-256 private JWK for the VC issuer under test. */
const VC_TEST_JWK =
  '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"nvmZzosnCfbDtHP4EqM-Ngov1eop7f1PUQ-VDqWvnjU","y":"TOzo9pz77WoetLKq-DrRvenfwTn7zj-3BDk78NeJOIE","crv":"P-256","d":"fxkNMS4pKeXfLMd-zeboOFlRorzHjPW3WcHAzcHrBiM"}';

export default defineConfig({
  // N3.js (via @dwk/solid-pod → @dwk/rdf) depends on `readable-stream`; map it
  // to workerd's native Node stream, same as packages/solid-pod/vitest.config.ts.
  resolve: {
    alias: {
      "readable-stream": "node:stream",
    },
  },
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          POD: { className: "SolidPodObject", useSQLite: true },
          STORAGE: { className: "RemoteStorageObject", useSQLite: true },
          ACTOR: { className: "ActivityPubObject", useSQLite: true },
          WEBAUTHN: { className: "WebAuthnObject", useSQLite: true },
          REPO: { className: "AtprotoRepoObject", useSQLite: true },
        },
        r2Buckets: ["BLOBS", "MEDIA"],
        d1Databases: [
          "AUTH_DB",
          "MICROPUB_DB",
          "MICROSUB_DB",
          "WEBSUB_DB",
          "WEBMENTION_INBOX",
          "GC_DB",
        ],
        queueProducers: {
          WEBMENTION_QUEUE: { queueName: "conformance-webmention" },
          WEBSUB_QUEUE: { queueName: "conformance-websub" },
          MICROSUB_QUEUE: { queueName: "conformance-microsub" },
        },
        bindings: {
          BASE_URL: "https://conformance.test",
          TOKEN_SIGNING_KEY: "conformance-test-token-signing-key",
          CONFORMANCE_PASSWORD: "conformance-test-password",
          CONFORMANCE_ADMIN_TOKEN: "conformance-test-admin-token",
          ACTIVITYPUB_PUBLIC_KEY_PEM: AP_PUBLIC_PEM,
          ACTIVITYPUB_PRIVATE_KEY_PEM: AP_PRIVATE_PEM,
          VC_SIGNING_KEY: VC_TEST_JWK,
          ATPROTO_PASSWORD: "conformance-test-atproto-password",
          ATPROTO_JWT_SECRET: "conformance-test-atproto-jwt-secret",
        },
      },
    }),
  ],
  test: {
    name: "@dwk/conformance-target",
  },
});
```

If `queueProducers`' option shape is rejected by the installed miniflare version, use the string-map form: `queueProducers: { WEBMENTION_QUEUE: "conformance-webmention", … }`.

- [ ] **Step 5: Write `src/config.ts`**

```typescript
/**
 * The conformance target's single env→config seam. `ConformanceEnv` is the
 * union of every mounted package's `Env` fragment — expressed as an interface
 * extends-chain so the compiler proves the fragments compose (shared bindings
 * like `BLOBS`, `GC_DB`, `AUTH_DB` must agree in type). `configsFor` builds
 * every package's config object from it; no package reads env directly
 * (spec/composition-contract.md).
 *
 * Not protocol logic: this package is deploy/test infrastructure and is never
 * published.
 *
 * @see docs/superpowers/specs/2026-07-04-conformance-target-design.md
 */

import type { ActivityPubConfig, ActivityPubEnv } from "@dwk/activitypub";
import type { AtprotoPdsConfig, AtprotoPdsEnv } from "@dwk/atproto-pds";
import type { HostMetaConfig, HostMetaEnv } from "@dwk/host-meta";
import type { IndieAuthConfig, IndieAuthEnv } from "@dwk/indieauth";
import type { MicropubConfig, MicropubEnv } from "@dwk/micropub";
import type { MicrosubConfig, MicrosubEnv } from "@dwk/microsub";
import type {
  RemoteStorageConfig,
  RemoteStorageEnv,
} from "@dwk/remotestorage";
import type { SolidPodConfig, SolidPodEnv } from "@dwk/solid-pod";
import type { VcConfig, VcEnv } from "@dwk/vc";
import type { WebAuthnConfig, WebAuthnEnv } from "@dwk/webauthn";
import type { WebfingerConfig, WebfingerEnv } from "@dwk/webfinger";
import type { WebmentionConfig, WebmentionEnv } from "@dwk/webmention";
import type { WebSubConfig, WebSubEnv } from "@dwk/websub";

import { approveAuthorization } from "./approval.js";

/** The local part of the test identity's `acct:` handle and AP username. */
export const USERNAME = "conformance";

/**
 * Union of every mounted package's Env fragment, plus this Worker's own vars
 * and secrets. The extends-chain is deliberate: it fails to compile if two
 * packages ever declare the same binding at incompatible types.
 */
export interface ConformanceEnv
  extends IndieAuthEnv,
    MicropubEnv,
    MicrosubEnv,
    WebmentionEnv,
    WebSubEnv,
    WebfingerEnv,
    HostMetaEnv,
    ActivityPubEnv,
    WebAuthnEnv,
    VcEnv,
    SolidPodEnv,
    RemoteStorageEnv,
    AtprotoPdsEnv {
  /** Public origin of the deployment (no trailing slash), e.g. `https://conformance.dwk.io`. */
  readonly BASE_URL: string;
  /** Password for the IndieAuth consent form (secret). */
  readonly CONFORMANCE_PASSWORD: string;
  /** Shared-secret bearer that authenticates as the pod owner (secret; interim until Solid-OIDC, P4). */
  readonly CONFORMANCE_ADMIN_TOKEN: string;
  /** ActivityPub actor keypair (PEM; private half is a secret). */
  readonly ACTIVITYPUB_PUBLIC_KEY_PEM: string;
  readonly ACTIVITYPUB_PRIVATE_KEY_PEM: string;
  /** atproto session credentials (secrets). */
  readonly ATPROTO_PASSWORD: string;
  readonly ATPROTO_JWT_SECRET: string;
}

/** The test identity's WebID (owner of both pods). */
export function ownerWebId(env: ConformanceEnv): string {
  return `${env.BASE_URL}/profile/card#me`;
}

/**
 * Interim owner authentication for the Solid pods: a shared-secret bearer
 * resolves to the owner WebID. Replaced by real Solid-OIDC in P4.
 */
function adminAuthenticate(env: ConformanceEnv): SolidPodConfig["authenticate"] {
  return (request) => {
    const auth = request.headers.get("authorization");
    if (auth === `Bearer ${env.CONFORMANCE_ADMIN_TOKEN}`) {
      return {
        webid: ownerWebId(env),
        jti: crypto.randomUUID(),
        jkt: "conformance-admin",
      };
    }
    return null;
  };
}

export interface TargetConfigs {
  readonly webfinger: WebfingerConfig;
  readonly hostMeta: HostMetaConfig;
  readonly indieauth: IndieAuthConfig;
  readonly micropub: MicropubConfig;
  readonly microsub: MicrosubConfig;
  readonly webmention: WebmentionConfig;
  readonly websub: WebSubConfig;
  readonly activitypub: ActivityPubConfig;
  readonly remotestorage: RemoteStorageConfig;
  readonly solidPod: SolidPodConfig;
  readonly davPod: SolidPodConfig;
  readonly webauthn: WebAuthnConfig;
  readonly vc: VcConfig;
  readonly atproto: AtprotoPdsConfig;
}

/** Build every package's config from the deployment env. */
export function configsFor(env: ConformanceEnv): TargetConfigs {
  const base = env.BASE_URL;
  const host = new URL(base).host;
  const me = `${base}/`;
  return {
    webfinger: {
      resources: {
        [`acct:${USERNAME}@${host}`]: {
          subject: `acct:${USERNAME}@${host}`,
          links: [
            {
              rel: "http://webfinger.net/rel/profile-page",
              href: me,
            },
            {
              rel: "self",
              type: "application/activity+json",
              href: `${base}/users/${USERNAME}`,
            },
          ],
        },
      },
    },
    hostMeta: { webfingerUrl: `${base}/.well-known/webfinger` },
    indieauth: {
      baseUrl: base,
      approveAuthorization: approveAuthorization(env),
    },
    micropub: { baseUrl: base, me },
    microsub: { baseUrl: base, me },
    webmention: { baseUrl: base },
    websub: {
      baseUrl: base,
      hubUrl: `${base}/websub`,
      allowedTopics: [me],
    },
    activitypub: {
      baseUrl: base,
      actor: { username: USERNAME, name: "Conformance Target" },
      publicKeyPem: env.ACTIVITYPUB_PUBLIC_KEY_PEM,
      privateKeyPem: env.ACTIVITYPUB_PRIVATE_KEY_PEM,
    },
    remotestorage: {
      baseUrl: base,
      parsePath: (pathname) => {
        const match = /^\/storage\/([^/]+)(\/.*)?$/.exec(pathname);
        if (!match || match[1] === undefined) return null;
        return {
          account: decodeURIComponent(match[1]),
          path: match[2] ?? "/",
        };
      },
    },
    solidPod: {
      baseUrl: `${base}/pod`,
      owner: ownerWebId(env),
      authenticate: adminAuthenticate(env),
    },
    // The litmus pod: its own DO (keyed by baseUrl), deliberately separate
    // from /pod — same-pod dual-door mounting is deferred to P4.
    davPod: {
      baseUrl: `${base}/dav`,
      owner: ownerWebId(env),
      authenticate: adminAuthenticate(env),
    },
    webauthn: {
      rpId: host,
      rpName: "dwk conformance target",
      origin: base,
    },
    vc: { baseUrl: base },
    atproto: {
      baseUrl: base,
      password: env.ATPROTO_PASSWORD,
      jwtSecret: env.ATPROTO_JWT_SECRET,
    },
  };
}
```

Cross-check each config field name against the package's exported config
interface as you go (they were verified against source at plan time; if a
field was renamed since, the compiler will tell you — fix the config, do not
change the package).

- [ ] **Step 6: Write a placeholder `src/approval.ts`** (fleshed out in Task 3; needed now so `config.ts` compiles)

```typescript
/**
 * IndieAuth authentication + consent for the conformance identity: a single
 * password (secret binding) guards approval. Task 3 implements the form.
 */

import type { IndieAuthConfig } from "@dwk/indieauth";

import type { ConformanceEnv } from "./config.js";

export function approveAuthorization(
  env: ConformanceEnv,
): IndieAuthConfig["approveAuthorization"] {
  return async () => new Response("Not Implemented", { status: 501 });
}
```

`env` is unused until Task 3 — prefix it `_env` for now (ESLint allows `^_`), and rename back in Task 3.

- [ ] **Step 7: Write minimal `src/index.ts`**

```typescript
/**
 * @dwk/conformance-target — every endpoint package composed into one Worker,
 * deployed to conformance.dwk.io as the target for the hosted conformance
 * suites (micropub.rocks, webmention.rocks, Solid harness, litmus). Private,
 * never published; doubles as the reference composition for the monorepo.
 *
 * @see docs/superpowers/specs/2026-07-04-conformance-target-design.md
 * @see spec/composition-contract.md
 */

import type { ConformanceEnv } from "./config.js";

export type { ConformanceEnv } from "./config.js";
export { configsFor, ownerWebId, USERNAME } from "./config.js";

// The five Durable Objects served by this Worker (wrangler.jsonc declares them
// against this module).
export { ActivityPubObject } from "@dwk/activitypub";
export { AtprotoRepoObject } from "@dwk/atproto-pds";
export { RemoteStorageObject } from "@dwk/remotestorage";
export { SolidPodObject } from "@dwk/solid-pod";
export { WebAuthnObject } from "@dwk/webauthn";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<ConformanceEnv>;
```

- [ ] **Step 8: Write `src/test-harness.ts`**

```typescript
/**
 * Test-only Worker entrypoint: re-exports the Durable Object classes so the
 * vitest pool can bind them, plus the composed Worker as default. Excluded
 * from the build; not part of the public surface.
 */

import worker from "./index.js";

export {
  ActivityPubObject,
  AtprotoRepoObject,
  RemoteStorageObject,
  SolidPodObject,
  WebAuthnObject,
} from "./index.js";

export default worker;
```

- [ ] **Step 9: Add the status.json entry**

In `conformance/status.json`, add after the `"@dwk/server"` entry (keep the object comma-valid):

```json
"@dwk/conformance-target": {
  "standard": null,
  "suites": {},
  "integration": {
    "status": "pending",
    "cases": []
  }
}
```

- [ ] **Step 10: Install and verify the scaffold**

Run: `pnpm install`
Expected: lockfile updates with the new workspace package, no errors.

Run: `pnpm --filter @dwk/conformance-target typecheck`
Expected: PASS (exit 0). Fix any config-interface drift the compiler reports.

Run: `pnpm test:gate`
Expected: PASS (gate unit tests still green with the new entry).

- [ ] **Step 11: Format and commit**

```bash
pnpm format
git add packages/conformance-target conformance/status.json pnpm-lock.yaml
git commit -m "feat(conformance-target): scaffold private composed-Worker package"
```

---

### Task 2: Router core + home handler + first smoke tests

**Files:**
- Create: `packages/conformance-target/src/mounts.ts`
- Create: `packages/conformance-target/src/home.ts`
- Create: `packages/conformance-target/src/smoke.test.ts`
- Modify: `packages/conformance-target/src/index.ts` (wire the router)

**Interfaces:**
- Consumes: `ConformanceEnv`, `configsFor`, `ownerWebId` from Task 1.
- Produces: `buildMounts(env: ConformanceEnv): readonly Mount[]`, `routeRequest(mounts, request, env, ctx): Promise<Response>`, `createHome(env): Handler`. `Mount = { name: string; matches(url: URL, request: Request): boolean; handler: Handler }`; `Handler = (request, env: ConformanceEnv, ctx) => Promise<Response>`. Tasks 3–5 add entries to the mount table in `buildMounts`.

- [ ] **Step 1: Write the failing smoke tests**

Create `src/smoke.test.ts`:

```typescript
/**
 * Per-mount smoke tests: every mounted package answers its cheapest request
 * (spec: "composition regressions are caught by ordinary pnpm test"). These
 * assert reachability + the protocol-certain response, not protocol depth —
 * that lives in each package's own tests.
 */

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ConformanceEnv } from "./index.js";
import worker from "./index.js";

const testEnv = env as unknown as ConformanceEnv;
const BASE = "https://conformance.test";

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, init),
    testEnv,
    createExecutionContext(),
  );
}

describe("home", () => {
  it("serves the h-card identity page with endpoint discovery links", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('class="h-card"');
    expect(body).toContain('rel="micropub"');
    expect(body).toContain('rel="webmention"');
    expect(body).toContain('rel="authorization_endpoint"');
  });

  it("serves the owner WebID profile document as Turtle", async () => {
    const res = await call("/profile/card");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/turtle");
    expect(await res.text()).toContain("#me");
  });

  it("404s unmounted paths", async () => {
    const res = await call("/no-such-mount");
    expect(res.status).toBe(404);
  });
});
```

Note: `worker.fetch` through the default export requires the fetch signature to accept `(request, env, ctx)` — that is what Step 3 implements.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/conformance-target`
Expected: FAIL — home page returns 404 from the Task 1 stub (and/or module resolution errors for `./mounts.js`, which don't exist yet).

- [ ] **Step 3: Write `src/home.ts`**

```typescript
/**
 * The test identity's static content: an h-card homepage advertising every
 * endpoint (several suites start from URL discovery, not the endpoint), and
 * the owner's WebID profile document. Grows test posts for webmention.rocks
 * in P2.
 */

import type { ConformanceEnv } from "./config.js";
import { ownerWebId } from "./config.js";

type Handler = (
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

function homePage(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>@dwk/workers conformance target</title>
<link rel="indieauth-metadata" href="${base}/.well-known/oauth-authorization-server">
<link rel="authorization_endpoint" href="${base}/authorize">
<link rel="token_endpoint" href="${base}/token">
<link rel="micropub" href="${base}/micropub">
<link rel="microsub" href="${base}/microsub">
<link rel="webmention" href="${base}/webmention">
<link rel="hub" href="${base}/websub">
<link rel="self" href="${base}/">
</head>
<body>
<article class="h-card">
  <a class="u-url p-name" href="${base}/">Conformance Target</a>
  <p class="p-note">Deployed composition of the @dwk/workers packages; the
  target the hosted conformance suites run against.</p>
</article>
</body>
</html>
`;
}

function profileCard(base: string, webid: string): string {
  return `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .

<${base}/profile/card>
    a foaf:PersonalProfileDocument ;
    foaf:primaryTopic <${webid}> .

<${webid}>
    a foaf:Person ;
    foaf:name "Conformance Target" .
`;
}

export function createHome(env: ConformanceEnv): Handler {
  const base = env.BASE_URL;
  const webid = ownerWebId(env);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response(homePage(base), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/profile/card") {
      return new Response(profileCard(base, webid), {
        headers: { "content-type": "text/turtle" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };
}
```

- [ ] **Step 4: Write `src/mounts.ts`**

```typescript
/**
 * The mount table: external path → package handler, first match wins. Every
 * entry is built from `configsFor(env)` so the paths here and the endpoint
 * URLs the packages advertise cannot drift apart. Tasks 3–5 fill the table.
 */

import type { ConformanceEnv } from "./config.js";
import { configsFor } from "./config.js";
import { createHome } from "./home.js";

export type Handler = (
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

export interface Mount {
  /** Package name, for diagnostics. */
  readonly name: string;
  /** Whether this mount owns the request. */
  readonly matches: (url: URL, request: Request) => boolean;
  readonly handler: Handler;
}

/** Build the full mount table once per isolate. */
export function buildMounts(env: ConformanceEnv): readonly Mount[] {
  const c = configsFor(env);
  void c; // used from Task 3 onward
  return [
    {
      name: "home",
      matches: (u) => u.pathname === "/" || u.pathname === "/profile/card",
      handler: createHome(env),
    },
  ];
}

/** Route a request through the mount table; unmatched paths are 404. */
export function routeRequest(
  mounts: readonly Mount[],
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  for (const mount of mounts) {
    if (mount.matches(url, request)) return mount.handler(request, env, ctx);
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}
```

- [ ] **Step 5: Wire the router into `src/index.ts`**

Replace the `export default` block with:

```typescript
import type { Mount } from "./mounts.js";
import { buildMounts, routeRequest } from "./mounts.js";

let mounts: readonly Mount[] | undefined;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    mounts ??= buildMounts(env);
    return routeRequest(mounts, request, env, ctx);
  },
} satisfies ExportedHandler<ConformanceEnv>;
```

(Keep the existing imports/re-exports; add the new import. `mounts` is memoized per isolate — configs are static per deployment.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS (3 tests).

- [ ] **Step 7: Format and commit**

```bash
pnpm format
git add packages/conformance-target
git commit -m "feat(conformance-target): mount-table router + test identity pages"
```

---

### Task 3: Discovery + IndieAuth mounts

**Files:**
- Modify: `packages/conformance-target/src/approval.ts` (real consent flow)
- Modify: `packages/conformance-target/src/mounts.ts` (add 3 mounts)
- Modify: `packages/conformance-target/src/smoke.test.ts` (add tests)

**Interfaces:**
- Consumes: `configsFor` (webfinger/hostMeta/indieauth entries), `approveAuthorization`.
- Produces: mounted `/.well-known/webfinger`, `/.well-known/host-meta[.json]`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/revocation`.

- [ ] **Step 1: Write the failing smoke tests** (append to `src/smoke.test.ts`)

```typescript
describe("discovery", () => {
  it("webfinger resolves the test acct: resource", async () => {
    const res = await call(
      "/.well-known/webfinger?resource=acct:conformance@conformance.test",
    );
    expect(res.status).toBe(200);
    const jrd = (await res.json()) as { subject: string };
    expect(jrd.subject).toBe("acct:conformance@conformance.test");
  });

  it("host-meta advertises the lrdd template", async () => {
    const res = await call("/.well-known/host-meta");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("lrdd");
  });
});

describe("@dwk/indieauth", () => {
  it("serves OAuth server metadata with the deployment issuer", async () => {
    const res = await call("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { issuer: string };
    expect(meta.issuer).toBe(BASE);
  });

  it("rejects an authorization request without client_id", async () => {
    const res = await call("/authorize");
    expect(res.status).toBe(400);
  });

  it("renders the consent form for a well-formed authorization request", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "https://app.example/",
      redirect_uri: "https://app.example/callback",
      state: "s1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const res = await call(`/authorize?${params}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="password"');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test --project @dwk/conformance-target`
Expected: FAIL — the discovery/indieauth requests hit the 404 fallback.

- [ ] **Step 3: Implement `src/approval.ts`**

Replace the file body with:

```typescript
/**
 * IndieAuth authentication + consent for the conformance identity: the library
 * owns the protocol; this hook renders a single-password consent form (GET)
 * and checks the password (POST). The password is the CONFORMANCE_PASSWORD
 * secret — good enough for a test identity, not a real IdP.
 */

import type { IndieAuthConfig } from "@dwk/indieauth";

import type { ConformanceEnv } from "./config.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Echo the authorization request back as hidden fields on the consent form. */
function consentForm(httpRequest: Request): string {
  const params = new URL(httpRequest.url).searchParams;
  const hidden = [...params.entries()]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  const clientId = escapeHtml(params.get("client_id") ?? "unknown client");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize</title></head>
<body>
<h1>Authorize ${clientId}</h1>
<form method="post">
${hidden}
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Approve</button>
</form>
</body>
</html>
`;
}

export function approveAuthorization(
  env: ConformanceEnv,
): IndieAuthConfig["approveAuthorization"] {
  return async (_request, httpRequest) => {
    if (httpRequest.method === "POST") {
      const form = await httpRequest.clone().formData();
      if (form.get("password") === env.CONFORMANCE_PASSWORD) {
        return { me: `${env.BASE_URL}/` };
      }
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(consentForm(httpRequest), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}
```

Check `packages/indieauth/src/handler.ts` (or its tests) for how the authorize
endpoint treats a POST: if the library reads the request body itself before
calling the hook, drop the `.clone()`; if it expects the POSTed params in the
body rather than the query, the hidden-field form is exactly what makes that
work. Adjust only this file, never the package.

- [ ] **Step 4: Add the mounts** (in `src/mounts.ts`, replace the `buildMounts` return with — this is the full table as of Task 3; `void c;` goes away)

```typescript
import { createHostMeta } from "@dwk/host-meta";
import { createIndieAuth } from "@dwk/indieauth";
import { createWebfinger } from "@dwk/webfinger";
```

```typescript
  return [
    {
      name: "@dwk/webfinger",
      matches: (u) => u.pathname === "/.well-known/webfinger",
      handler: createWebfinger(c.webfinger),
    },
    {
      name: "@dwk/host-meta",
      matches: (u) =>
        u.pathname === "/.well-known/host-meta" ||
        u.pathname === "/.well-known/host-meta.json",
      handler: createHostMeta(c.hostMeta),
    },
    {
      name: "@dwk/indieauth",
      matches: (u) =>
        u.pathname === "/.well-known/oauth-authorization-server" ||
        u.pathname === "/authorize" ||
        u.pathname === "/token" ||
        u.pathname === "/revocation",
      handler: createIndieAuth(c.indieauth),
    },
    {
      name: "home",
      matches: (u) => u.pathname === "/" || u.pathname === "/profile/card",
      handler: createHome(env),
    },
  ];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS. If the metadata issuer assertion fails because the package
appends a trailing slash, update the assertion to the observed
protocol-correct value (RFC 8414 issuers are compared verbatim).

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add packages/conformance-target
git commit -m "feat(conformance-target): mount webfinger, host-meta, indieauth"
```

---

### Task 4: IndieWeb content mounts (micropub, microsub, webmention, websub)

**Files:**
- Modify: `packages/conformance-target/src/mounts.ts`
- Modify: `packages/conformance-target/src/smoke.test.ts`

**Interfaces:**
- Consumes: `configsFor` entries `micropub`, `microsub`, `webmention`, `websub`.
- Produces: mounted `/micropub`, `/media[/*]`, `/microsub`, `/webmention`, `/websub`.

- [ ] **Step 1: Write the failing smoke tests** (append)

```typescript
describe("IndieWeb endpoints", () => {
  it("micropub config query requires a token", async () => {
    const res = await call("/micropub?q=config");
    expect(res.status).toBe(401);
  });

  it("microsub requires a token", async () => {
    const res = await call("/microsub?action=channels");
    expect(res.status).toBe(401);
  });

  it("webmention rejects a mention without source/target", async () => {
    const res = await call("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "source=",
    });
    expect(res.status).toBe(400);
  });

  it("webmention accepts a well-formed mention for our origin", async () => {
    const res = await call("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        source: "https://sender.example/post",
        target: `${BASE}/`,
      }).toString(),
    });
    // Async verification via WEBMENTION_QUEUE: the spec allows 201 (status
    // resource created) or 202 (accepted for processing).
    expect([201, 202]).toContain(res.status);
  });

  it("websub rejects a subscription for a foreign topic", async () => {
    const res = await call("/websub", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": "https://evil.example/feed",
        "hub.callback": "https://subscriber.example/cb",
      }).toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test --project @dwk/conformance-target`
Expected: FAIL — all five hit the 404 fallback.

- [ ] **Step 3: Add the mounts**

Add imports:

```typescript
import { createMicropub } from "@dwk/micropub";
import { createMicrosub } from "@dwk/microsub";
import { createWebmention } from "@dwk/webmention";
import { createWebSub } from "@dwk/websub";
```

Insert into the `buildMounts` array (before the `home` entry):

```typescript
    {
      name: "@dwk/micropub",
      matches: (u) =>
        u.pathname === "/micropub" ||
        u.pathname === "/media" ||
        u.pathname.startsWith("/media/"),
      handler: createMicropub(c.micropub),
    },
    {
      name: "@dwk/microsub",
      matches: (u) => u.pathname === "/microsub",
      handler: createMicrosub(c.microsub),
    },
    {
      name: "@dwk/webmention",
      matches: (u) => u.pathname === "/webmention",
      handler: createWebmention(c.webmention),
    },
    {
      name: "@dwk/websub",
      matches: (u) => u.pathname === "/websub",
      handler: createWebSub(c.websub),
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS. The 401s prove the shared `AUTH_DB`/`TOKEN_SIGNING_KEY`
bindings reach micropub/microsub through the union Env.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add packages/conformance-target
git commit -m "feat(conformance-target): mount micropub, microsub, webmention, websub"
```

---

### Task 5: Storage + identity mounts (solid-pod, WebDAV doors, remotestorage, webauthn, vc, activitypub, atproto-pds)

**Files:**
- Modify: `packages/conformance-target/src/mounts.ts`
- Modify: `packages/conformance-target/src/smoke.test.ts`

**Interfaces:**
- Consumes: `configsFor` entries `solidPod`, `davPod`, `remotestorage`, `webauthn`, `vc`, `activitypub`, `atproto`.
- Produces: mounted `/pod/*`, `/dav/*`, `/dav-credentials`, `/storage/*`, `/webauthn/*`, `/credentials/*`, `/users/conformance*` + nodeinfo, `/xrpc/*` + atproto well-knowns.

- [ ] **Step 1: Write the failing smoke tests** (append)

```typescript
describe("storage and identity endpoints", () => {
  it("solid pod denies an anonymous read", async () => {
    const res = await call("/pod/");
    // Owner-only default ACL. If the package's default makes the pod root
    // public-readable (check its handler tests), change this to 200.
    expect(res.status).toBe(401);
  });

  it("solid pod admits the admin bearer as owner", async () => {
    const res = await call("/pod/", {
      headers: { authorization: "Bearer conformance-test-admin-token" },
    });
    expect(res.status).toBe(200);
  });

  it("webdav door challenges with Basic", async () => {
    const res = await call("/dav/", { method: "PROPFIND" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("Basic");
  });

  it("mints an app password and writes through the WebDAV door", async () => {
    const mint = await call("/dav-credentials", {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-test-admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "smoke",
        scope: { modes: ["read", "write"] },
      }),
    });
    expect(mint.status).toBe(201);
    const cred = (await mint.json()) as { username: string; secret: string };
    const put = await call("/dav/smoke.txt", {
      method: "PUT",
      headers: {
        authorization: `Basic ${btoa(`${cred.username}:${cred.secret}`)}`,
        "content-type": "text/plain",
      },
      body: "hello",
    });
    expect(put.status).toBe(201);
  });

  it("remotestorage denies an anonymous private read", async () => {
    const res = await call("/storage/conformance/notes/today");
    expect(res.status).toBe(401);
  });

  it("webauthn registration options endpoint is mounted", async () => {
    const res = await call("/webauthn/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "conformance" }),
    });
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it("vc verify endpoint is mounted", async () => {
    const res = await call("/credentials/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it("serves the ActivityPub actor document", async () => {
    const res = await call("/users/conformance", {
      headers: { accept: "application/activity+json" },
    });
    expect(res.status).toBe(200);
    const actor = (await res.json()) as { preferredUsername: string };
    expect(actor.preferredUsername).toBe("conformance");
  });

  it("serves nodeinfo discovery", async () => {
    const res = await call("/.well-known/nodeinfo");
    expect(res.status).toBe(200);
  });

  it("serves the atproto DID binding", async () => {
    const res = await call("/.well-known/atproto-did");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("did:web:conformance.test");
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test --project @dwk/conformance-target`
Expected: FAIL — all hit the 404 fallback.

- [ ] **Step 3: Add the mounts**

Add imports:

```typescript
import { createActivityPub } from "@dwk/activitypub";
import { createAtprotoPds } from "@dwk/atproto-pds";
import { createRemoteStorage } from "@dwk/remotestorage";
import {
  createSolidPod,
  createSolidPodWebdav,
  createSolidPodWebdavCredentials,
} from "@dwk/solid-pod";
import { createVc } from "@dwk/vc";
import { createWebAuthn } from "@dwk/webauthn";
```

Insert into the `buildMounts` array (before the `home` entry). `USERNAME` is imported from `./config.js`:

```typescript
    {
      name: "@dwk/activitypub",
      matches: (u) =>
        u.pathname === `/users/${USERNAME}` ||
        u.pathname.startsWith(`/users/${USERNAME}/`) ||
        u.pathname === "/inbox" ||
        u.pathname === "/.well-known/nodeinfo" ||
        u.pathname.startsWith("/nodeinfo/"),
      handler: createActivityPub(c.activitypub),
    },
    {
      name: "@dwk/remotestorage",
      matches: (u) => u.pathname.startsWith("/storage/"),
      handler: createRemoteStorage(c.remotestorage),
    },
    {
      name: "@dwk/solid-pod",
      matches: (u) => u.pathname === "/pod" || u.pathname.startsWith("/pod/"),
      handler: createSolidPod(c.solidPod),
    },
    {
      name: "@dwk/webdav (litmus pod door)",
      matches: (u) => u.pathname === "/dav" || u.pathname.startsWith("/dav/"),
      handler: createSolidPodWebdav(c.davPod),
    },
    {
      name: "@dwk/webdav (credentials)",
      matches: (u) => u.pathname === "/dav-credentials",
      handler: createSolidPodWebdavCredentials(c.davPod),
    },
    {
      name: "@dwk/webauthn",
      matches: (u) => u.pathname.startsWith("/webauthn/"),
      handler: createWebAuthn(c.webauthn),
    },
    {
      name: "@dwk/vc",
      matches: (u) => u.pathname.startsWith("/credentials/"),
      handler: createVc(c.vc),
    },
    {
      name: "@dwk/atproto-pds",
      matches: (u) =>
        u.pathname.startsWith("/xrpc/") ||
        u.pathname === "/.well-known/atproto-did" ||
        u.pathname === "/.well-known/did.json",
      handler: createAtprotoPds(c.atproto),
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS. Debug notes for likely first-run failures:
- Solid pod anonymous/admin expectations: check the actual status against
  `packages/solid-pod/src/handler.ts` WAC defaults and its tests; adjust the
  assertion to the protocol-correct observed value.
- App-password mint body shape: authoritative shape is in
  `packages/solid-pod/src/webdav-credentials.test.ts` (`label`, `scope.modes`).
- atproto `did:web` text: exact body format is in
  `packages/atproto-pds/src/index.test.ts`.

Known limitation to record as a code comment on the `vc` mount: the VC
issuer's default `did:web` resolves to `/.well-known/did.json`, which the
atproto mount serves with *its* keys — a VC issue→verify round-trip against
the deployed target will fail DID resolution until the VC issuer gets its own
DID path. That is P5 scope (`vc-data-model-2.0` suite), not P1; the smoke
test intentionally only proves the mount answers.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add packages/conformance-target
git commit -m "feat(conformance-target): mount storage + identity packages"
```

---

### Task 6: queue() and scheduled() handlers

**Files:**
- Modify: `packages/conformance-target/src/index.ts`
- Modify: `packages/conformance-target/src/smoke.test.ts`

**Interfaces:**
- Consumes: `configsFor`; `createWebmentionQueueConsumer` + `WebmentionJob` (`@dwk/webmention`), `createWebSubQueueConsumer` + `WebSubJob` (`@dwk/websub`), `createMicrosubQueueConsumer` (`@dwk/microsub`), `createSolidPodGc` (`@dwk/solid-pod`).
- Produces: the final `ExportedHandler` with `fetch`, `queue`, `scheduled`.

- [ ] **Step 1: Write the failing tests** (append)

```typescript
describe("queue and scheduled handlers", () => {
  function emptyBatch(queue: string): MessageBatch<never> {
    return {
      queue,
      messages: [],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<never>;
  }

  it("dispatches known queues and rejects unknown ones", async () => {
    const ctx = createExecutionContext();
    await expect(
      worker.queue(emptyBatch("conformance-webmention"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("conformance-websub"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("conformance-microsub"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("no-such-queue"), testEnv, ctx),
    ).rejects.toThrow(/unknown queue/);
  });

  it("runs the shared GC pass", async () => {
    const controller = {
      scheduledTime: Date.now(),
      cron: "*/15 * * * *",
      noRetry() {},
    } as unknown as ScheduledController;
    await expect(
      worker.scheduled(controller, testEnv, createExecutionContext()),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/conformance-target`
Expected: FAIL — `worker.queue` / `worker.scheduled` are undefined (type error at compile or runtime).

- [ ] **Step 3: Implement `queue` and `scheduled` in `src/index.ts`**

Add imports:

```typescript
import { createMicrosubQueueConsumer } from "@dwk/microsub";
import { createSolidPodGc } from "@dwk/solid-pod";
import type { WebmentionJob } from "@dwk/webmention";
import { createWebmentionQueueConsumer } from "@dwk/webmention";
import type { WebSubJob } from "@dwk/websub";
import { createWebSubQueueConsumer } from "@dwk/websub";

import { configsFor } from "./config.js";
```

Extend the default export:

```typescript
type AnyJob = WebmentionJob | WebSubJob | unknown;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    mounts ??= buildMounts(env);
    return routeRequest(mounts, request, env, ctx);
  },

  async queue(batch, env, ctx): Promise<void> {
    const c = configsFor(env);
    switch (batch.queue) {
      case "conformance-webmention":
        return createWebmentionQueueConsumer(c.webmention)(
          batch as MessageBatch<WebmentionJob>,
          env,
          ctx,
        );
      case "conformance-websub":
        return createWebSubQueueConsumer(c.websub)(
          batch as MessageBatch<WebSubJob>,
          env,
          ctx,
        );
      case "conformance-microsub":
        return createMicrosubQueueConsumer(c.microsub)(
          batch as Parameters<
            ReturnType<typeof createMicrosubQueueConsumer>
          >[0],
          env,
          ctx,
        );
      default:
        throw new Error(
          `@dwk/conformance-target: unknown queue "${batch.queue}"`,
        );
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    // solid-pod and remotestorage share the @dwk/store GC schema and the same
    // BLOBS/GC_DB bindings, so one collector pass covers both packages.
    await createSolidPodGc(configsFor(env).solidPod)(event, env, ctx);
  },
} satisfies ExportedHandler<ConformanceEnv, AnyJob>;
```

If `createWebSubQueueConsumer`'s config parameter type differs from
`WebSubConfig` (check `packages/websub/src/handler.ts`), pass whatever it
declares — the point is one consumer per queue, built from the same
`configsFor` output the fetch handlers use.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS. If the GC pass throws on a missing GC table, check whether the
gc handler expects `ensureGcSchema` to have run (see `@dwk/store` exports) and
call it first inside `scheduled` — mirror whatever `packages/solid-pod/src/gc.ts`'s
own tests do.

- [ ] **Step 5: Run the full suite, format, commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across all projects (proves no other package broke).

```bash
pnpm format
git add packages/conformance-target
git commit -m "feat(conformance-target): queue consumers + shared GC schedule"
```

---

### Task 7: wrangler.jsonc + README runbook + doc pointers

**Files:**
- Create: `packages/conformance-target/wrangler.jsonc`
- Create: `packages/conformance-target/README.md`
- Modify: `conformance/README.md` (target section)
- Modify: `spec/conformance-and-testing.md` (target pointer)
- Modify: `CLAUDE.md` (package count sentence)

**Interfaces:**
- Consumes: binding names from `ConformanceEnv`; DO class names from `src/index.ts` re-exports.
- Produces: the deployable config + the operator runbook Task 8's CI job and the litmus run depend on.

- [ ] **Step 1: Write `wrangler.jsonc`**

```jsonc
// Deploy config for the conformance target (conformance.dwk.io).
// One-time resource setup (D1 ids, buckets, queues, secrets) is documented in
// README.md — the placeholder database_id values below MUST be replaced with
// the ids `wrangler d1 create` prints before the first deploy.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dwk-conformance-target",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [
    { "pattern": "conformance.dwk.io", "custom_domain": true }
  ],
  "vars": {
    "BASE_URL": "https://conformance.dwk.io"
  },
  "durable_objects": {
    "bindings": [
      { "name": "POD", "class_name": "SolidPodObject" },
      { "name": "STORAGE", "class_name": "RemoteStorageObject" },
      { "name": "ACTOR", "class_name": "ActivityPubObject" },
      { "name": "WEBAUTHN", "class_name": "WebAuthnObject" },
      { "name": "REPO", "class_name": "AtprotoRepoObject" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "SolidPodObject",
        "RemoteStorageObject",
        "ActivityPubObject",
        "WebAuthnObject",
        "AtprotoRepoObject"
      ]
    }
  ],
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "dwk-conformance-blobs" },
    { "binding": "MEDIA", "bucket_name": "dwk-conformance-media" }
  ],
  "d1_databases": [
    { "binding": "AUTH_DB", "database_name": "dwk-conformance-auth", "database_id": "REPLACE-AFTER-d1-create" },
    { "binding": "MICROPUB_DB", "database_name": "dwk-conformance-micropub", "database_id": "REPLACE-AFTER-d1-create" },
    { "binding": "MICROSUB_DB", "database_name": "dwk-conformance-microsub", "database_id": "REPLACE-AFTER-d1-create" },
    { "binding": "WEBSUB_DB", "database_name": "dwk-conformance-websub", "database_id": "REPLACE-AFTER-d1-create" },
    { "binding": "WEBMENTION_INBOX", "database_name": "dwk-conformance-webmention", "database_id": "REPLACE-AFTER-d1-create" },
    { "binding": "GC_DB", "database_name": "dwk-conformance-gc", "database_id": "REPLACE-AFTER-d1-create" }
  ],
  "queues": {
    "producers": [
      { "binding": "WEBMENTION_QUEUE", "queue": "conformance-webmention" },
      { "binding": "WEBSUB_QUEUE", "queue": "conformance-websub" },
      { "binding": "MICROSUB_QUEUE", "queue": "conformance-microsub" }
    ],
    "consumers": [
      { "queue": "conformance-webmention" },
      { "queue": "conformance-websub" },
      { "queue": "conformance-microsub" }
    ]
  },
  "triggers": {
    "crons": ["*/15 * * * *"]
  },
  "observability": {
    "enabled": true
  }
}
```

- [ ] **Step 2: Write `README.md`**

````markdown
# @dwk/conformance-target

The deployed conformance target for the `@dwk/workers` monorepo: every
endpoint package composed into one Worker behind `https://conformance.dwk.io`,
per `spec/composition-contract.md`. The hosted conformance suites
(micropub.rocks, webmention.rocks, the Solid harness, litmus) run against it;
`conformance/status.json` records the results. **Private — never published.**
It doubles as the reference for "how do I compose these packages into one
Worker".

## Mount table

| Path | Package |
| --- | --- |
| `/.well-known/webfinger` | `@dwk/webfinger` |
| `/.well-known/host-meta[.json]` | `@dwk/host-meta` |
| `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/revocation` | `@dwk/indieauth` |
| `/micropub`, `/media/*` | `@dwk/micropub` |
| `/microsub` | `@dwk/microsub` |
| `/webmention` | `@dwk/webmention` |
| `/websub` | `@dwk/websub` |
| `/users/conformance*`, `/inbox`, `/.well-known/nodeinfo`, `/nodeinfo/*` | `@dwk/activitypub` |
| `/storage/<account>/*` | `@dwk/remotestorage` |
| `/pod/*` | `@dwk/solid-pod` (LDP door) |
| `/dav/*` | `@dwk/solid-pod` WebDAV door — **its own pod** (litmus target) |
| `/dav-credentials` | app-password mint/list/revoke (owner-gated) |
| `/webauthn/*` | `@dwk/webauthn` |
| `/credentials/*` | `@dwk/vc` |
| `/xrpc/*`, `/.well-known/atproto-did`, `/.well-known/did.json` | `@dwk/atproto-pds` |
| `/`, `/profile/card` | test identity (h-card + WebID) |

The `/dav` pod is deliberately separate from `/pod`: the per-pod Durable
Object is keyed by the configured `baseUrl`, so mounting both doors on one pod
requires verb-based dispatch — deferred until the Solid conformance phase.

Owner authentication is an interim shared-secret bearer
(`Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN`) that resolves to the owner
WebID `https://conformance.dwk.io/profile/card#me`. It is replaced by real
Solid-OIDC in the Solid harness phase.

## One-time setup

Prereqs: the `dwk.io` zone on the Cloudflare account; `wrangler` authenticated
(`wrangler login` locally, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
in CI). All commands run from `packages/conformance-target/`.

1. Create the R2 buckets and D1 databases:

   ```bash
   wrangler r2 bucket create dwk-conformance-blobs
   wrangler r2 bucket create dwk-conformance-media
   for db in auth micropub microsub websub webmention gc; do
     wrangler d1 create "dwk-conformance-$db"
   done
   ```

   Paste each printed `database_id` into `wrangler.jsonc` (replacing the
   `REPLACE-AFTER-d1-create` placeholders) and commit.

2. Create the queues:

   ```bash
   wrangler queues create conformance-webmention
   wrangler queues create conformance-websub
   wrangler queues create conformance-microsub
   ```

3. Set the secrets (each prompts for a value; generate long random strings —
   `openssl rand -base64 32` — except the PEMs/JWK):

   ```bash
   wrangler secret put TOKEN_SIGNING_KEY
   wrangler secret put CONFORMANCE_PASSWORD
   wrangler secret put CONFORMANCE_ADMIN_TOKEN
   wrangler secret put ATPROTO_PASSWORD
   wrangler secret put ATPROTO_JWT_SECRET
   # RSA keypair for the ActivityPub actor:
   #   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ap.pem
   #   openssl pkey -in ap.pem -pubout -out ap.pub.pem
   wrangler secret put ACTIVITYPUB_PUBLIC_KEY_PEM   # paste ap.pub.pem
   wrangler secret put ACTIVITYPUB_PRIVATE_KEY_PEM  # paste ap.pem
   # P-256 private JWK for the VC issuer:
   #   node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))"
   wrangler secret put VC_SIGNING_KEY
   ```

4. In the GitHub repo, add the `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit,
   Workers Routes:Edit, D1:Edit, Queues:Edit, R2:Edit) and
   `CLOUDFLARE_ACCOUNT_ID` secrets for the CI deploy job.

## Deploy

From the repo root (dependencies must be built first — wrangler bundles the
workspace packages from their `dist/`):

```bash
pnpm build
pnpm --filter @dwk/conformance-target deploy
```

Or trigger the `Conformance` workflow's deploy job (`workflow_dispatch`).

## Running litmus (WebDAV conformance)

1. Mint a read-write app password:

   ```bash
   curl -sS -X POST https://conformance.dwk.io/dav-credentials \
     -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"label":"litmus","scope":{"modes":["read","write"]}}'
   ```

   The response contains `username` and `secret` (shown once).

2. Run the suite through the dispatcher (litmus must be installed —
   `apt-get install litmus` / `brew install litmus`):

   ```bash
   node scripts/conformance/run-suite.mjs webdav \
     --target https://conformance.dwk.io/dav/ \
     --username <username> --password <secret>
   ```

3. On green, record the result in `conformance/status.json`
   (`@dwk/webdav` → suites → litmus → `"passing"`, with the run date), and
   revoke the credential:

   ```bash
   curl -sS -X DELETE "https://conformance.dwk.io/dav-credentials?id=<credentialId>" \
     -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN"
   ```

## Resetting suite data

Suite runs accumulate state in the DOs / R2 / D1 of this deployment. To reset:
delete and recreate the D1 databases and R2 buckets (step 1 above), then
redeploy — DO storage for `new_sqlite_classes` is dropped with
`wrangler delete` + redeploy. Never point suites at a production identity.
````

- [ ] **Step 3: Doc pointers**

In `conformance/README.md`, add a short section (adapt to the file's existing structure):

```markdown
## Deployed target

The suites run against `packages/conformance-target` — a private Worker
composing every endpoint package, deployed to https://conformance.dwk.io via
the `deploy-target` job in `.github/workflows/conformance.yml`. See
`packages/conformance-target/README.md` for setup and per-suite runbooks.
```

In `spec/conformance-and-testing.md`, extend the "How the gate is wired" section with one bullet:

```markdown
- **Target:** the hosted suites run against the composed conformance Worker
  ([`packages/conformance-target`](../packages/conformance-target/README.md)),
  deployed to `conformance.dwk.io` by the `deploy-target` job.
```

In `CLAUDE.md`, update the status sentence that says `@dwk/server` is the only private package: it now reads that there are 23 publishable packages **plus two private ones** — `@dwk/server` (Docker-only host) and `@dwk/conformance-target` (the deployed conformance Worker, `conformance.dwk.io`). Keep the edit minimal and in the file's existing voice.

- [ ] **Step 4: Verify nothing broke**

Run: `pnpm typecheck && pnpm test --project @dwk/conformance-target && pnpm release:gate`
Expected: all PASS (wrangler.jsonc is not consumed by any of these; this guards the doc/status edits).

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add packages/conformance-target conformance/README.md spec/conformance-and-testing.md CLAUDE.md
git commit -m "feat(conformance-target): wrangler config + deploy/litmus runbook"
```

---

### Task 8: CI deploy job

**Files:**
- Modify: `.github/workflows/conformance.yml`

**Interfaces:**
- Consumes: the `packages/conformance-target` package and its `deploy` script; repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (added by the operator, Task 7 README step 4).
- Produces: `deploy-target` job; `hosted-suite` depends on it.

- [ ] **Step 1: Add the `deploy-target` job**

Insert between the `integration` and `hosted-suite` jobs:

```yaml
  # Deploys the composed conformance target (packages/conformance-target) to
  # conformance.dwk.io so the hosted suites have something to run against.
  # Skips gracefully when the Cloudflare secrets are not configured, so the
  # weekly schedule stays green on forks / before one-time setup.
  deploy-target:
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - name: Check Cloudflare credentials
        id: creds
        run: echo "ok=${{ secrets.CLOUDFLARE_API_TOKEN != '' }}" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v7
        if: steps.creds.outputs.ok == 'true'
      - uses: pnpm/action-setup@v6
        if: steps.creds.outputs.ok == 'true'
      - uses: actions/setup-node@v6
        if: steps.creds.outputs.ok == 'true'
        with:
          # Node 24 for parity with CI: @dwk/server's node:sqlite shims run
          # flag-free (spec/self-hosting.md §16 decision 2).
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
        if: steps.creds.outputs.ok == 'true'
      - name: Build workspace packages
        if: steps.creds.outputs.ok == 'true'
        run: pnpm build
      - name: Deploy conformance target
        if: steps.creds.outputs.ok == 'true'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: packages/conformance-target
      - name: Deploy skipped
        if: steps.creds.outputs.ok != 'true'
        run: echo "CLOUDFLARE_API_TOKEN not configured; skipping deploy."
```

- [ ] **Step 2: Make `hosted-suite` wait for the deploy**

Change the `hosted-suite` job's opening lines to:

```yaml
  hosted-suite:
    needs: deploy-target
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'
```

(`needs` + the unchanged `if` keeps current behaviour: both jobs share the same triggers, and a skipped deploy still lets the suite job run its documented no-op.) Note: `needs` skips the dependent job if the needed job fails — that is desired (don't test a failed deploy). A *skipped* deploy step inside a succeeded job does not block it.

- [ ] **Step 3: Validate the workflow syntax**

Run: `npx --yes yaml-lint .github/workflows/conformance.yml`
Expected: parses cleanly. (Alternatively push the branch and confirm the Actions tab shows no workflow parse error.)

- [ ] **Step 4: Commit**

```bash
pnpm format
git add .github/workflows/conformance.yml
git commit -m "ci(conformance): deploy the conformance target before hosted suites"
```

---

### Task 9: Full verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: Run the full CI-equivalent pipeline locally**

Run, in order (same order as `.github/workflows/ci.yml`):

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

Expected: all five PASS. `pnpm build` proves the package's `tsconfig.build.json` emits cleanly (wrangler deploy depends on built workspace deps).

- [ ] **Step 2: Run the gates**

```bash
pnpm test:gate
pnpm release:gate
pnpm test:integration
```

Expected: all PASS.

- [ ] **Step 3: Verify the dispatcher still no-ops without a target**

Run: `node scripts/conformance/run-suite.mjs webdav`
Expected: exit 0, prints the litmus procedure (unchanged behaviour).

- [ ] **Step 4: Fix anything that failed, format, and commit any fixes**

```bash
pnpm format
git add -A
git commit -m "chore(conformance-target): verification fixes" # only if there are changes
```

---

## Out of plan (operator + later phases)

- **Operator (DWK) actions after merge:** one-time setup from the README
  (buckets, D1 ids committed, queues, secrets, GitHub secrets), first deploy,
  litmus run, recording the litmus result in `status.json`. The plan ships
  everything up to — but not including — the live run.
- **P2:** webmention.rocks runner; **P3:** `record.mjs` + manual runbooks;
  **P4:** Solid-OIDC spike + harness (includes same-pod dual-door mounting);
  **P5:** long tail. Each gets its own plan.
