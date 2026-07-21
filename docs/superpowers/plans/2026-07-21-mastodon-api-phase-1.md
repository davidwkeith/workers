# Mastodon API Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement phase 1 of `spec/mastodon-client-api.md` (issue #348): the new `@dwk/mastodon-api` endpoint package with the Mastodon app OAuth flow, instance + verify_credentials endpoints, marker persistence, and the stub roster, so a real Mastodon-API client can register, complete OAuth, and render the owner account.

**Architecture:** A new endpoint package holding the pure Mastodon entity serializers, a `/api/*` + `/oauth/*` router (`createMastodonApi`), and a D1-backed store (`AUTH_DB`) for apps/codes/tokens/markers. Auth is Mastodon-shaped OAuth built on `@dwk/oauth` building blocks (`validateClientMetadata`, `createRevocationHandler`, the new `ClientStore` seam) with opaque SHA-256-hashed bearer tokens — the documented DPoP exception. The `MastodonBackend` seam is defined but unused until phase 2; owner-account data comes from config with zero counts.

**Tech Stack:** TypeScript (strict, ESM-only), Cloudflare Workers (D1), vitest under workerd via `@cloudflare/vitest-pool-workers`, `@dwk/oauth` + `@dwk/log` workspace deps.

## Global Constraints

- **Formatting:** Prettier — semicolons, double quotes, trailing commas `all`, 80-column width. `pnpm format:check` is a CI gate; run `pnpm format` before each commit.
- **TypeScript:** strict via `tsconfig.base.json` (`noUncheckedIndexedAccess`, `noUnusedLocals`, `verbatimModuleSyntax`, `isolatedModules`). Use `import type` for type-only imports. Unused vars must be `_`-prefixed.
- **ESM-only**, `"sideEffects": false`, exports map to `dist/`, publishes `dist` + `src` minus tests. Internal deps use `"workspace:*"`.
- **Composition contract:** handler shape `createMastodonApi(config): (request, env, ctx) => Promise<Response>`; no global env reads — all config injected; **fail loudly** if `AUTH_DB` binding is missing.
- **Consistency:** auth state in D1 only — **never KV**. Codes single-use via conditional `UPDATE … RETURNING`.
- **Tokens:** opaque 256-bit random, stored as SHA-256 hex hashes. Plain `Bearer` — the documented DPoP exception (read-only surface, isolated audience).
- **Scopes:** recorded as requested, **echoed as granted** — never narrowed (real clients treat narrowing as an error).
- **Commits:** Conventional Commits, e.g. `feat(mastodon-api): …`, `feat(oauth): …`. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Mastodon error shape** everywhere under `/api/`: JSON `{"error": "..."}` with the appropriate status.
- Run tests scoped: `pnpm test --project @dwk/mastodon-api` (a bare filter errors against other projects).
- New package version starts at `"0.0.0"` with a `minor` changeset (pre-mode convention; `changeset version` produces `0.1.0-beta.0`).

## File Structure

```
packages/oauth/src/store.ts            # MODIFY: add ClientStore interface
packages/oauth/src/index.ts            # MODIFY: export ClientStore
packages/oauth/src/store.test.ts       # CREATE: ClientStore contract test
packages/mastodon-api/
  package.json                         # CREATE (version 0.0.0)
  tsconfig.json / tsconfig.build.json  # CREATE
  vitest.config.ts                     # CREATE (workerd, AUTH_DB d1)
  README.md / CLAUDE.md                # CREATE
  src/index.ts                         # public surface + doc comment
  src/config.ts                        # MastodonApiConfig, Env fragment, approval hook types
  src/backend.ts                       # MastodonBackend seam types (used in phase 2)
  src/errors.ts                        # Mastodon error responses
  src/encoding.ts                      # base64url, random token, sha256, PKCE S256
  src/store.ts                         # MastodonStore + createMastodonStore (D1)
  src/entities.ts                      # Application/CredentialAccount/Instance/Marker serializers
  src/apps.ts                          # POST /api/v1/apps (+ verify_credentials)
  src/oauth-flow.ts                    # /oauth/authorize + /oauth/token
  src/auth.ts                          # bearer authentication + client authentication
  src/stubs.ts                         # data-driven stub roster
  src/handler.ts                       # createMastodonApi router (CORS, 404 fallback)
  src/*.test.ts                        # colocated tests
spec/packages/mastodon-api.md          # CREATE: per-package spec seeded from design
spec/README.md                         # MODIFY: link the new package spec
CLAUDE.md                              # MODIFY: package counts/lists
catalog.json                           # MODIFY: mastodon-api worker entry
.changeset/oauth-client-store-seam.md  # CREATE
.changeset/mastodon-api-phase-1.md     # CREATE
```

Design decisions locked here (rationale in `spec/mastodon-client-api.md`):

- The owner account id is the constant string `"1"` (single-owner deployment; phase 2's remote-account ids derive from a hash and cannot collide).
- App entity `id` is `String(clientIdIssuedAt)` (not used for pagination).
- `client_credentials` tokens have `accountId: null`; only `/api/v1/apps/verify_credentials` and public endpoints accept them. Account-required endpoints reject them with `422 {"error":"This method requires an authenticated user."}` (Mastodon's actual behavior).
- App rows are stored as `@dwk/oauth` `ClientRecord`s (metadata bag; `clientSecret` holds the SHA-256 hash — the field is documented "hashed/opaque"), so the store implements the new `ClientStore` seam directly.
- CORS `*` with preflight support on the whole surface (web clients like Elk/Phanpy are a stretch row of the conformance matrix; native apps ignore it).
- The vitest project runs entirely under workerd (repo rule: one environment per package; runtime-bound ⇒ workerd). The pure entity tests are colocated and run there too.
- Avatar/header fallback for the owner account is a 1×1 transparent PNG `data:` URI when unconfigured (required fields; the real bundled-default question belongs to phase 2's synthesized remote accounts).

---

### Task 1: `@dwk/oauth` ClientStore seam

**Files:**

- Modify: `packages/oauth/src/store.ts`
- Modify: `packages/oauth/src/index.ts`
- Create: `packages/oauth/src/store.test.ts`
- Create: `.changeset/oauth-client-store-seam.md`

**Interfaces:**

- Consumes: existing `ClientRecord` in `packages/oauth/src/store.ts`.
- Produces: `interface ClientStore { saveClient(record: ClientRecord): Promise<void>; getClient(clientId: string): Promise<ClientRecord | null>; }` exported from `@dwk/oauth`. Task 4's `MastodonStore` extends it.

- [ ] **Step 1: Write the failing test**

`packages/oauth/src/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ClientRecord, ClientStore } from "./store.js";

/** In-memory reference implementation, as a consumer would write for tests. */
function memoryClientStore(): ClientStore {
  const clients = new Map<string, ClientRecord>();
  return {
    async saveClient(record) {
      clients.set(record.clientId, record);
    },
    async getClient(clientId) {
      return clients.get(clientId) ?? null;
    },
  };
}

describe("ClientStore", () => {
  it("round-trips a saved client and misses unknown ids", async () => {
    const store = memoryClientStore();
    const record: ClientRecord = {
      clientId: "abc",
      clientIdIssuedAt: 1_700_000_000,
      clientSecret: "hashed-secret",
      metadata: { client_name: "Test", redirect_uris: ["https://a/cb"] },
    };
    await store.saveClient(record);
    expect(await store.getClient("abc")).toEqual(record);
    expect(await store.getClient("missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/oauth store`
Expected: FAIL — `"./store.js"` has no exported member `ClientStore` (type error surfaces at `pnpm typecheck` / vitest transform).

- [ ] **Step 3: Add the interface**

Append to `packages/oauth/src/store.ts` (after `ClientRecord`):

```ts
/**
 * Read/write storage for registered OAuth clients (RFC 7591).
 *
 * {@link ClientRegistrationConfig.saveClient} deliberately only *writes*; the
 * grant endpoints a consumer builds on top (authorize, token) need the read
 * side to verify redirect URIs and client secrets. This seam names both halves
 * so consumers implement one interface and unit-test against a `Map`.
 */
export interface ClientStore {
  /** Persist a newly registered client record. */
  saveClient(record: ClientRecord): Promise<void>;
  /** Fetch a registered client by `client_id`, or `null` when unknown. */
  getClient(clientId: string): Promise<ClientRecord | null>;
}
```

In `packages/oauth/src/index.ts` extend the store type re-export:

```ts
export type {
  IntrospectionTokenRecord,
  PushedRequestRecord,
  PushedAuthorizationStore,
  ClientRecord,
  ClientStore,
} from "./store.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/oauth store` → PASS. Then `pnpm --filter @dwk/oauth typecheck` → clean.

- [ ] **Step 5: Changeset + commit**

`.changeset/oauth-client-store-seam.md`:

```md
---
"@dwk/oauth": minor
---

Add the `ClientStore` seam — `getClient(clientId)` alongside `saveClient` — so
consumers building authorize/token grants over the RFC 7591 registration
handler can verify redirect URIs and client secrets through one interface.
```

```bash
git add packages/oauth/src/store.ts packages/oauth/src/index.ts packages/oauth/src/store.test.ts .changeset/oauth-client-store-seam.md
git commit -m "feat(oauth): add ClientStore read seam (getClient) for grant-building consumers"
```

---

### Task 2: Scaffold `@dwk/mastodon-api` (package files, config types, error helpers, 404/CORS router shell)

**Files:**

- Create: `packages/mastodon-api/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `README.md`, `CLAUDE.md`
- Create: `packages/mastodon-api/src/index.ts`, `src/config.ts`, `src/backend.ts`, `src/errors.ts`, `src/handler.ts`
- Test: `packages/mastodon-api/src/handler.test.ts`

**Interfaces:**

- Consumes: `Logger`/`Metrics` from `@dwk/log`.
- Produces: `createMastodonApi(config): (request: Request, env: MastodonApiEnv, ctx: ExecutionContext) => Promise<Response>`; `MastodonApiEnv { AUTH_DB: D1Database }`; `MastodonApiConfig` (fields below); `ApproveMastodonAuthorization`; `MastodonBackend` seam types; `mastodonError(status, message)`. Later tasks register routes in `handler.ts`'s route table.

- [ ] **Step 1: Package metadata files**

`packages/mastodon-api/package.json`:

```json
{
  "name": "@dwk/mastodon-api",
  "version": "0.0.0",
  "description": "Mastodon-compatible client API subset: app OAuth login, instance metadata, and read-only account/timeline endpoints for off-the-shelf fediverse clients.",
  "keywords": [
    "mastodon",
    "fediverse",
    "activitypub",
    "oauth2",
    "cloudflare-workers"
  ],
  "type": "module",
  "license": "ISC",
  "author": "David W. Keith <me@dwk.io>",
  "homepage": "https://github.com/davidwkeith/workers/tree/main/packages/mastodon-api#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/davidwkeith/workers.git",
    "directory": "packages/mastodon-api"
  },
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "src", "!src/**/*.test.ts"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "clean": "rm -rf dist"
  },
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "@dwk/log": "workspace:*",
    "@dwk/oauth": "workspace:*"
  }
}
```

`tsconfig.json` and `tsconfig.build.json`: copy `packages/webdav/tsconfig.json` and `packages/webdav/tsconfig.build.json` verbatim (they are path-relative; the build excludes `src/**/*.test.ts` and `src/test-harness.ts` — the latter is harmlessly absent here).

`vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-05",
        d1Databases: ["AUTH_DB"],
      },
    }),
  ],
  test: {
    name: "@dwk/mastodon-api",
  },
});
```

`README.md` — brief: what it is (read-only Mastodon client API subset, phase 1 = login + identity), the factory + config sketch, the bearer-token DPoP exception note, pointer to `spec/packages/mastodon-api.md`. `CLAUDE.md` — follow `packages/indieauth/CLAUDE.md`'s section shape (What this is / Spec / Key constraints / Test environment / File layout / Dependencies), stating: D1 `AUTH_DB` (shared binding name, no indieauth dependency), opaque hashed bearer tokens as the documented DPoP exception, scopes echoed never narrowed, workerd tests.

- [ ] **Step 2: Config, backend seam, and error types**

`packages/mastodon-api/src/config.ts`:

```ts
/**
 * Configuration for {@link createMastodonApi}. Per the composition contract the
 * package never reads the global environment — instance metadata, the owner
 * account, and the approval hook all arrive here, so it can be instantiated
 * multiple times and tested in isolation.
 */

import type { Logger, Metrics } from "@dwk/log";

import type { MastodonBackend } from "./backend.js";

/** Cloudflare bindings required by `@dwk/mastodon-api`. */
export interface MastodonApiEnv {
  /** D1 database holding apps, codes, tokens, and markers (shared `AUTH_DB`). */
  readonly AUTH_DB: D1Database;
}

/** Instance-level metadata served by the `instance` endpoints. */
export interface InstanceMetadata {
  /** Instance title. */
  readonly title: string;
  /** Longer instance description. */
  readonly description?: string;
  /** Contact email surfaced in the instance documents. */
  readonly contactEmail?: string;
  /** ISO 639-1 content languages. Defaults to `["en"]`. */
  readonly languages?: readonly string[];
  /** Thumbnail image URL. */
  readonly thumbnail?: string;
}

/** The single owner account this deployment serves. */
export interface OwnerAccount {
  /** The `acct:` local part / login handle. */
  readonly username: string;
  /** Display name; defaults to {@link username}. */
  readonly displayName?: string;
  /** Bio, as HTML. Defaults to empty. */
  readonly note?: string;
  /** Profile page URL; defaults to `${baseUrl}/users/${username}`. */
  readonly url?: string;
  /** Avatar image URL; a transparent-pixel data URI when unset. */
  readonly avatar?: string;
  /** Header image URL; a transparent-pixel data URI when unset. */
  readonly header?: string;
  /** Account creation date (ISO 8601). Defaults to the Unix epoch. */
  readonly createdAt?: string;
}

/** A validated authorization request handed to the approval hook. */
export interface MastodonAuthorizationRequest {
  readonly clientId: string;
  /** Registered `client_name`, for the consent screen. */
  readonly clientName: string;
  /** The exact-matched redirect URI (may be `urn:ietf:wg:oauth:2.0:oob`). */
  readonly redirectUri: string;
  /** Space-separated requested scopes (echoed as granted, never narrowed). */
  readonly scope: string;
  readonly scopes: readonly string[];
  /** Opaque client state, echoed back on redirect. */
  readonly state?: string;
}

/** The approval hook's affirmative decision. */
export interface MastodonApproval {
  readonly approved: true;
}

/**
 * Authentication + consent hook — the deployer's concern, exactly as
 * `@dwk/indieauth`'s `approveAuthorization`. Return a {@link MastodonApproval}
 * to mint a code and redirect, or a `Response` to take over the exchange
 * (render a login/consent page); the library returns that `Response` unchanged.
 */
export type ApproveMastodonAuthorization = (
  request: MastodonAuthorizationRequest,
  httpRequest: Request,
) => Promise<MastodonApproval | Response>;

/** Configuration passed to {@link createMastodonApi}. */
export interface MastodonApiConfig {
  /** Public origin of the composed Worker, e.g. `https://example.com`. */
  readonly baseUrl: string;
  readonly instance: InstanceMetadata;
  readonly account: OwnerAccount;
  readonly approveAuthorization: ApproveMastodonAuthorization;
  /**
   * Suffix for the compatibility `version` string
   * `"4.2.0 (compatible; dwk-workers/<softwareVersion>)"`. Defaults to `"0"`.
   */
  readonly softwareVersion?: string;
  /** Authorization-code lifetime in seconds. Defaults to 600. */
  readonly authorizationCodeLifetimeSeconds?: number;
  /** Page-size defaults/ceiling for the phase-2 list endpoints. */
  readonly pageSize?: { readonly default: number; readonly max: number };
  /** Live-count + timeline backend; absent in phase 1 (counts render as 0). */
  readonly backend?: MastodonBackend;
  /** Structured logger; defaults to no-op. */
  readonly logger?: Logger;
  /** Metrics sink; defaults to no-op. */
  readonly metrics?: Metrics;
}

/** The one local account id this deployment ever mints (single-owner). */
export const OWNER_ACCOUNT_ID = "1";
```

`packages/mastodon-api/src/backend.ts` — the seam, verbatim from the design (`BackendPageQuery`, `BackendEntry`, plus):

```ts
/**
 * The plain-data backend seam `@dwk/activitypub`'s adapter implements in
 * phase 2 (spec/mastodon-client-api.md, Decision 1). Defined here so the
 * protocol core stays free of Durable Object knowledge.
 */

/** Live collection counts for the owner actor. */
export interface BackendAccountCounts {
  readonly followers: number;
  readonly following: number;
  readonly statuses: number;
}

/** Actor profile + live counts. Phase 1 uses only the counts. */
export interface BackendAccount {
  readonly counts: BackendAccountCounts;
}

export interface BackendPageQuery {
  /** Page size; clamped by the backend. */
  readonly limit: number;
  /** Exclusive upper bound (snowflake id). */
  readonly maxId?: string;
  /** Exclusive lower bound. */
  readonly sinceId?: string;
  /** Exclusive lower bound, oldest-first window. */
  readonly minId?: string;
}

/** A stored inbox row, AS2 JSON verbatim. */
export interface BackendEntry {
  /** Snowflake id (spec/mastodon-client-api.md, Decision 3). */
  readonly id: string;
  readonly activity: Record<string, unknown>;
  readonly receivedAt: number;
  readonly objectType: string | null;
  readonly relayedBy: string | null;
}

export interface BackendPage<T> {
  readonly entries: readonly T[];
}

export interface MastodonBackend {
  /** Actor profile + live counts (followers/following/statuses). */
  account(): Promise<BackendAccount>;
  /** Newest-first page of timeline entries (Create/Announce rows). */
  timeline(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Newest-first page of notification entries. */
  notifications(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Single stored entry by snowflake id. */
  entry(id: string): Promise<BackendEntry | null>;
}
```

`packages/mastodon-api/src/errors.ts`:

```ts
/** Mastodon-style JSON error responses: `{"error": "..."}` with a status. */

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Serialize a Mastodon error body. */
export function mastodonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

/** `401` — missing/unknown/revoked bearer token (Mastodon's wording). */
export function invalidToken(): Response {
  return mastodonError(401, "The access token is invalid");
}

/** `404` — anything unrouted under `/api/` (Mastodon's wording). */
export function recordNotFound(): Response {
  return mastodonError(404, "Record not found");
}

/** `422` — an app-level (`client_credentials`) token on an account endpoint. */
export function accountRequired(): Response {
  return mastodonError(422, "This method requires an authenticated user.");
}
```

- [ ] **Step 3: Write the failing router-shell test**

`packages/mastodon-api/src/handler.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createMastodonApi } from "./index.js";
import type { MastodonApiConfig, MastodonApiEnv } from "./index.js";

export const config: MastodonApiConfig = {
  baseUrl: "https://owner.example",
  instance: { title: "Owner's site" },
  account: { username: "owner" },
  approveAuthorization: async () => ({ approved: true }),
};

const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;

function api(cfg: MastodonApiConfig = config) {
  const handler = createMastodonApi(cfg);
  return (request: Request) =>
    handler(request, env as unknown as MastodonApiEnv, ctx);
}

describe("createMastodonApi shell", () => {
  it("fails loudly when AUTH_DB is missing", async () => {
    const handler = createMastodonApi(config);
    await expect(
      handler(
        new Request("https://owner.example/api/v1/instance"),
        {} as MastodonApiEnv,
        ctx,
      ),
    ).rejects.toThrow(/AUTH_DB/);
  });

  it("404s unknown /api/ paths with the Mastodon error shape", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Record not found" });
  });

  it("answers CORS preflight and marks responses CORS-open", async () => {
    const preflight = await api()(
      new Request("https://owner.example/api/v1/instance", {
        method: "OPTIONS",
        headers: { origin: "https://elk.zone" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const res = await api()(new Request("https://owner.example/api/v1/nope"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm install && pnpm test --project @dwk/mastodon-api handler`
Expected: FAIL — `createMastodonApi` not exported.

- [ ] **Step 5: Implement the router shell**

`packages/mastodon-api/src/handler.ts`:

```ts
/**
 * `createMastodonApi` — the `/api/v1/*`, `/api/v2/*`, and `/oauth/*` router.
 * Routes are registered by feature modules; everything unrouted under `/api/`
 * gets Mastodon's 404 error shape. The whole surface is CORS-open (`*`) so
 * web clients (Elk, Phanpy) can call it; native apps ignore CORS.
 */

import type { MastodonApiConfig, MastodonApiEnv } from "./config.js";
import { recordNotFound } from "./errors.js";

/** Per-request context threaded to route handlers. */
export interface RouteContext {
  readonly config: MastodonApiConfig;
  readonly env: MastodonApiEnv;
  readonly request: Request;
  readonly url: URL;
}

type RouteHandler = (ctx: RouteContext) => Promise<Response>;

/** Exact-path routes, keyed `"METHOD /path"`. Feature tasks add entries. */
const ROUTES: ReadonlyMap<string, RouteHandler> = new Map<string, RouteHandler>(
  [],
);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
} as const;

function withCors(response: Response): Response {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    wrapped.headers.set(name, value);
  }
  return wrapped;
}

/** Create the Mastodon client-API handler (composition-contract shape). */
export function createMastodonApi(
  config: MastodonApiConfig,
): (
  request: Request,
  env: MastodonApiEnv,
  ctx: ExecutionContext,
) => Promise<Response> {
  return async (request, env, _ctx) => {
    if (!env.AUTH_DB) {
      throw new Error(
        "@dwk/mastodon-api: missing required D1 binding `AUTH_DB`",
      );
    }
    if (request.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const route = ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (route) {
      return withCors(await route({ config, env, request, url }));
    }
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/oauth/")
    ) {
      return withCors(recordNotFound());
    }
    return withCors(recordNotFound());
  };
}
```

`packages/mastodon-api/src/index.ts`:

```ts
/**
 * `@dwk/mastodon-api` — a Mastodon-compatible client API subset.
 *
 * An endpoint package (Cloudflare specifics allowed): off-the-shelf
 * Mastodon-API clients (Pixelfed's app, Tusky, Elk) log in via the
 * Mastodon-shaped app OAuth flow — built on `@dwk/oauth`'s building blocks,
 * with opaque SHA-256-hashed bearer tokens in D1 as the repo's documented,
 * mitigated exception to the DPoP-everywhere rule — and browse a **read-only**
 * surface. Publishing stays with micropub/MCP; this package adds no write
 * path. The Durable-Object-backed data arrives through the injected
 * {@link MastodonBackend} seam, which `@dwk/activitypub`'s
 * `createActivitypubMastodonApi` adapter implements (the webdav/solid-pod
 * precedent); the protocol core here has no DO knowledge and tests against
 * in-memory fakes.
 *
 * @see spec/packages/mastodon-api.md
 * @packageDocumentation
 */

export { createMastodonApi } from "./handler.js";
export {
  OWNER_ACCOUNT_ID,
  type MastodonApiConfig,
  type MastodonApiEnv,
  type InstanceMetadata,
  type OwnerAccount,
  type MastodonAuthorizationRequest,
  type MastodonApproval,
  type ApproveMastodonAuthorization,
} from "./config.js";
export type {
  MastodonBackend,
  BackendAccount,
  BackendAccountCounts,
  BackendPage,
  BackendPageQuery,
  BackendEntry,
} from "./backend.js";
export { mastodonError } from "./errors.js";
```

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `pnpm test --project @dwk/mastodon-api handler` → PASS; `pnpm --filter @dwk/mastodon-api typecheck` → clean; `pnpm format`.

```bash
git add packages/mastodon-api pnpm-lock.yaml
git commit -m "feat(mastodon-api): scaffold endpoint package with router shell, config, and backend seam"
```

---

### Task 3: Encoding helpers (tokens, hashing, PKCE)

**Files:**

- Create: `packages/mastodon-api/src/encoding.ts`
- Test: `packages/mastodon-api/src/encoding.test.ts`

**Interfaces:**

- Produces: `randomToken(): string` (256-bit base64url), `sha256Hex(input: string): Promise<string>`, `verifyPkceS256(verifier: string, challenge: string): Promise<boolean>`, `timingSafeEqualHex(a: string, b: string): boolean`. Used by tasks 4, 6, 7, 8, 10.

- [ ] **Step 1: Write the failing test**

`packages/mastodon-api/src/encoding.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  verifyPkceS256,
} from "./encoding.js";

describe("encoding", () => {
  it("mints 43-char base64url tokens without padding", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it("hashes to lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("verifies an RFC 7636 appendix-B S256 pair", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256("wrong-verifier", challenge)).toBe(false);
  });

  it("compares hex strings timing-safely", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test --project @dwk/mastodon-api encoding` → FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/mastodon-api/src/encoding.ts`:

```ts
/** Token minting, hashing, and PKCE helpers (Web Crypto only). */

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A 256-bit random base64url identifier (tokens, codes, client ids). */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** SHA-256 of a UTF-8 string as lowercase hex (token/secret storage form). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** RFC 7636 §4.6: `challenge === BASE64URL(SHA256(verifier))`. */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return base64Url(new Uint8Array(digest)) === challenge;
}

/**
 * Constant-time comparison for equal-length hex digests, so secret checks
 * don't leak match length. Unequal lengths return `false` immediately —
 * digest lengths are public.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test --project @dwk/mastodon-api encoding` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/encoding.ts packages/mastodon-api/src/encoding.test.ts
git commit -m "feat(mastodon-api): token minting, hashing, and PKCE helpers"
```

---

### Task 4: D1 store (`MastodonStore`)

**Files:**

- Create: `packages/mastodon-api/src/store.ts`
- Test: `packages/mastodon-api/src/store.test.ts`

**Interfaces:**

- Consumes: `ClientRecord`, `ClientStore` from `@dwk/oauth` (Task 1); `MastodonApiEnv` (Task 2).
- Produces:

```ts
interface MastodonCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | null;
  expiresAt: number; // seconds
}
interface MastodonTokenRecord {
  tokenHash: string;
  clientId: string;
  scope: string;
  accountId: string | null; // null ⇒ client_credentials
  createdAt: number;
  revoked: boolean;
}
interface MastodonMarkerRecord {
  timeline: "home" | "notifications";
  lastReadId: string;
  version: number;
  updatedAt: number;
}
interface MastodonStore extends ClientStore {
  init(): Promise<void>;
  saveCode(record: MastodonCodeRecord): Promise<void>;
  redeemCode(code: string, now: number): Promise<MastodonCodeRecord | null>;
  saveToken(record: MastodonTokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<MastodonTokenRecord | null>;
  revokeToken(tokenHash: string): Promise<void>;
  getMarkers(
    timelines: readonly string[],
  ): Promise<readonly MastodonMarkerRecord[]>;
  saveMarker(
    timeline: "home" | "notifications",
    lastReadId: string,
    now: number,
  ): Promise<MastodonMarkerRecord>;
}
function createMastodonStore(env: MastodonApiEnv): MastodonStore;
```

- [ ] **Step 1: Write the failing tests**

`packages/mastodon-api/src/store.test.ts` (representative — cover every method):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { ClientRecord } from "@dwk/oauth";

import type { MastodonApiEnv } from "./config.js";
import { createMastodonStore } from "./store.js";

const testEnv = env as unknown as MastodonApiEnv;

function appRecord(id = "client-1"): ClientRecord {
  return {
    clientId: id,
    clientIdIssuedAt: 1_700_000_000,
    clientSecret: "sha256-of-secret",
    metadata: {
      client_name: "Tusky",
      redirect_uris: ["app://oauth-callback"],
      scope: "read write follow push",
      client_uri: "https://tusky.app",
    },
  };
}

describe("createMastodonStore", () => {
  beforeEach(async () => {
    await testEnv.AUTH_DB.exec(
      "DROP TABLE IF EXISTS mastodon_apps; DROP TABLE IF EXISTS mastodon_codes; DROP TABLE IF EXISTS mastodon_tokens; DROP TABLE IF EXISTS mastodon_markers;",
    );
  });

  it("fails loudly without AUTH_DB", () => {
    expect(() => createMastodonStore({} as MastodonApiEnv)).toThrow(/AUTH_DB/);
  });

  it("round-trips apps as ClientRecords", async () => {
    const store = createMastodonStore(testEnv);
    await store.saveClient(appRecord());
    expect(await store.getClient("client-1")).toEqual(appRecord());
    expect(await store.getClient("missing")).toBeNull();
  });

  it("redeems a code exactly once and never after expiry", async () => {
    const store = createMastodonStore(testEnv);
    const record = {
      code: "code-1",
      clientId: "client-1",
      redirectUri: "app://oauth-callback",
      scope: "read",
      codeChallenge: null,
      expiresAt: 2_000,
    };
    await store.saveCode(record);
    expect(await store.redeemCode("code-1", 1_000)).toEqual(record);
    expect(await store.redeemCode("code-1", 1_000)).toBeNull(); // single-use
    await store.saveCode({ ...record, code: "code-2" });
    expect(await store.redeemCode("code-2", 3_000)).toBeNull(); // expired
  });

  it("stores, reads, and revokes tokens by hash", async () => {
    const store = createMastodonStore(testEnv);
    const record = {
      tokenHash: "hash-1",
      clientId: "client-1",
      scope: "read",
      accountId: "1",
      createdAt: 1_000,
      revoked: false,
    };
    await store.saveToken(record);
    expect(await store.getToken("hash-1")).toEqual(record);
    await store.revokeToken("hash-1");
    expect((await store.getToken("hash-1"))?.revoked).toBe(true);
    await store.revokeToken("unknown"); // idempotent no-op
  });

  it("upserts markers with version increments", async () => {
    const store = createMastodonStore(testEnv);
    const first = await store.saveMarker("home", "101", 1_000);
    expect(first).toEqual({
      timeline: "home",
      lastReadId: "101",
      version: 1,
      updatedAt: 1_000,
    });
    const second = await store.saveMarker("home", "202", 2_000);
    expect(second.version).toBe(2);
    expect(await store.getMarkers(["home", "notifications"])).toEqual([
      { timeline: "home", lastReadId: "202", version: 2, updatedAt: 2_000 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `pnpm test --project @dwk/mastodon-api store` → module missing.

- [ ] **Step 3: Implement**

`packages/mastodon-api/src/store.ts` — follow `packages/indieauth/src/store.ts`'s conventions exactly (lazy `ensureSchema` with cached-promise reset on failure, opportunistic pruning, loud missing-binding error):

```ts
/**
 * D1-backed authoritative state: registered apps (as `@dwk/oauth`
 * `ClientRecord`s — `clientSecret` holds the SHA-256 hash), single-use
 * authorization codes (conditional `UPDATE … RETURNING`), SHA-256-hashed
 * opaque bearer tokens, and per-timeline read markers. Auth state is
 * security-sensitive, so it lives in D1 — **never KV**
 * (spec/non-functional-requirements.md).
 */

import type { ClientRecord, ClientStore } from "@dwk/oauth";

import type { MastodonApiEnv } from "./config.js";

// … record interfaces exactly as in this task's Interfaces block …

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mastodon_apps (
     client_id TEXT PRIMARY KEY,
     client_secret_hash TEXT NOT NULL,
     metadata TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_codes (
     code TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     scope TEXT NOT NULL,
     code_challenge TEXT,
     expires_at INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_tokens (
     token_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     account_id TEXT,
     created_at INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_markers (
     timeline TEXT PRIMARY KEY,
     last_read_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mastodon_codes_expires_at
     ON mastodon_codes(expires_at)`,
] as const;
```

Implementation notes (all shown patterns come from `packages/indieauth/src/store.ts`):

- `createMastodonStore(env)` throws `new Error("@dwk/mastodon-api: missing required D1 binding \`AUTH_DB\`")`when`!env.AUTH_DB`.
- `saveClient` serializes `record.metadata` as JSON into `metadata`, stores `record.clientSecret ?? ""` in `client_secret_hash` and `record.clientIdIssuedAt` in `created_at`. `getClient` reverses it (omit `clientSecret` when the column is empty). Before each `saveClient`, opportunistically prune expired codes (`DELETE FROM mastodon_codes WHERE expires_at <= ?`) and never-authorized stale apps:

```ts
`DELETE FROM mastodon_apps
  WHERE created_at <= ?
    AND client_id NOT IN (SELECT client_id FROM mastodon_tokens)`;
// bound to now − 30 days (2_592_000 s): an unwanted registration costs one
// D1 row for at most a month (spec/mastodon-client-api.md, Decision 2).
```

- `redeemCode` is the conditional-UPDATE pattern verbatim:

```ts
`UPDATE mastodon_codes SET used = 1
  WHERE code = ? AND used = 0 AND expires_at > ?
  RETURNING code, client_id, redirect_uri, scope, code_challenge, expires_at`;
```

- `saveMarker` is an upsert with version increment, returning the row:

```ts
`INSERT INTO mastodon_markers (timeline, last_read_id, version, updated_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(timeline) DO UPDATE SET
    last_read_id = excluded.last_read_id,
    version = mastodon_markers.version + 1,
    updated_at = excluded.updated_at
  RETURNING timeline, last_read_id, version, updated_at`;
```

- `getMarkers(timelines)` builds a `WHERE timeline IN (?, ?)` from the (validated, internal) list.
- Token rows map `revoked` 0/1 ↔ boolean.

- [ ] **Step 4: Run to verify PASS** — `pnpm test --project @dwk/mastodon-api store` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/store.ts packages/mastodon-api/src/store.test.ts
git commit -m "feat(mastodon-api): D1 store for apps, single-use codes, hashed tokens, and markers"
```

---

### Task 5: Entity serializers

**Files:**

- Create: `packages/mastodon-api/src/entities.ts`
- Test: `packages/mastodon-api/src/entities.test.ts`

**Interfaces:**

- Consumes: `MastodonApiConfig`, `OwnerAccount`, `OWNER_ACCOUNT_ID` (Task 2); `ClientRecord` (`@dwk/oauth`); `BackendAccountCounts` (Task 2); `MastodonMarkerRecord` (Task 4).
- Produces (all pure; every required Mastodon field emitted):
  - `applicationEntity(record: ClientRecord, opts?: { clientSecret?: string }): Record<string, unknown>` — `{id, name, website, redirect_uri, redirect_uris}` (+ `client_id`, `client_secret` only when `opts.clientSecret` is passed, i.e. at registration). `id = String(record.clientIdIssuedAt)`; `redirect_uri` is the registered URIs newline-joined (legacy field), `redirect_uris` the array; **no `vapid_key`**.
  - `credentialAccountEntity(config: MastodonApiConfig, counts: BackendAccountCounts): Record<string, unknown>` — full CredentialAccount: `id: OWNER_ACCOUNT_ID`, `username`, `acct` (= username, local), `display_name`, `locked: false`, `bot: false`, `discoverable: true`, `group: false`, `created_at`, `note`, `url`, `avatar`/`avatar_static`/`header`/`header_static` (fallback `TRANSPARENT_PIXEL` data URI), `followers_count`/`following_count`/`statuses_count` from `counts`, `last_status_at: null`, `emojis: []`, `fields: []`, `source: { privacy: "public", sensitive: false, language: null, note, fields: [], follow_requests_count: 0 }`.
  - `instanceV1Entity(config, host: string): Record<string, unknown>` — `{uri: host, title, short_description, description, email, version: compatibilityVersion(config), urls: {}, stats: {user_count: 1, status_count: 0, domain_count: 0}, thumbnail, languages, registrations: false, approval_required: true, invites_enabled: false, contact_account: null}`. **No `urls.streaming_api`** (design: clients fall back to polling).
  - `instanceV2Entity(config, host: string): Record<string, unknown>` — `{domain: host, title, version: compatibilityVersion(config), source_url: "https://github.com/davidwkeith/workers", description, usage: {users: {active_month: 1}}, thumbnail: {url}, languages, configuration: {accounts: {max_featured_tags: 0}, statuses: {max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23}, media_attachments: {supported_mime_types: []}, polls: {max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746}}, registrations: {enabled: false, approval_required: true, message: null}, contact: {email, account: null}, rules: []}`.
  - `compatibilityVersion(config): string` — `` `4.2.0 (compatible; dwk-workers/${config.softwareVersion ?? "0"})` `` (GoToSocial-style; clients parse it for feature detection).
  - `markerEntity(record: MastodonMarkerRecord): Record<string, unknown>` — `{last_read_id, version, updated_at: ISO8601}`.
  - `TRANSPARENT_PIXEL` — 1×1 transparent PNG data URI constant.

- [ ] **Step 1: Write failing tests** asserting, for each serializer, the exact JSON for a fully-configured config and the defaults path (e.g. avatar fallback = `TRANSPARENT_PIXEL`, `display_name` defaulting to username, `acct` without domain, version string `"4.2.0 (compatible; dwk-workers/0.1.0)"` when `softwareVersion: "0.1.0"`). Include one test that `applicationEntity` without `opts` has no `client_secret`/`client_id` keys and never a `vapid_key` key.

- [ ] **Step 2: Run to verify FAIL** — `pnpm test --project @dwk/mastodon-api entities`.

- [ ] **Step 3: Implement** `entities.ts` as pure functions per the Interfaces block. Fields are built by typed extraction from `record.metadata` (`client_name`, `client_uri`, `redirect_uris`) with safe defaults — never spread from stored JSON (security consideration in the design).

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): mastodon entity serializers (application, account, instance, marker)`

---

### Task 6: `POST /api/v1/apps` (registration wire adapter)

**Files:**

- Create: `packages/mastodon-api/src/apps.ts`
- Modify: `packages/mastodon-api/src/handler.ts` (route table)
- Test: `packages/mastodon-api/src/apps.test.ts`

**Interfaces:**

- Consumes: `validateClientMetadata` (`@dwk/oauth`), `createMastodonStore` (Task 4), `randomToken`/`sha256Hex` (Task 3), `applicationEntity` (Task 5), `mastodonError` (Task 2).
- Produces: `handleCreateApp(ctx: RouteContext): Promise<Response>` registered as `POST /api/v1/apps`. Reads form-encoded **or** JSON bodies with fields `client_name` (required), `redirect_uris` (string — possibly newline-separated — or array; required), `scopes` (space-separated, default `"read"`), `website` (optional).

- [ ] **Step 1: Write failing tests** (drive through `createMastodonApi` as in Task 2's harness):
  - JSON body `{client_name: "Tusky", redirect_uris: "app://oauth-callback", scopes: "read write follow push", website: "https://tusky.app"}` → `200` with `{id, name: "Tusky", website, redirect_uri: "app://oauth-callback", redirect_uris: ["app://oauth-callback"], client_id, client_secret}`; `client_secret` is 43-char base64url; a `vapid_key` key is absent.
  - Form-encoded body works identically.
  - Custom-scheme (`app://…`) and `urn:ietf:wg:oauth:2.0:oob` redirect URIs are accepted (RFC 8252).
  - Missing `client_name` or `redirect_uris` → `422` Mastodon error shape (`{"error": …}`).
  - The stored record's `clientSecret` is the SHA-256 hash, not the plaintext (fetch via `createMastodonStore(env).getClient(...)`).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** `apps.ts`:
  - Parse body by content type (`application/json` via `request.json()` in try/catch; otherwise `request.formData()` — Mastodon accepts both). Normalize `redirect_uris` to an array (split on newlines when a string).
  - Map to RFC 7591 metadata: `{client_name, redirect_uris, scope: scopes ?? "read", client_uri: website, token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "client_credentials"], response_types: ["code"]}`.
  - Call `validateClientMetadata(metadata, { saveClient: async () => {}, grantTypesSupported: ["authorization_code", "client_credentials"] })` — structural validation only (parseable absolute URL, no fragment; custom schemes pass; **no** `redirectUriPolicy`, per the design's RFC 8252 note). On `"error" in result` → `mastodonError(422, "Validation failed: " + description)`.
  - Mint `clientId = randomToken()`, `clientSecret = randomToken()`; build the `ClientRecord` with `clientSecret: await sha256Hex(clientSecret)` and the normalized metadata; `store.saveClient(record)`.
  - Respond `applicationEntity(record, { clientSecret })` (plaintext returned exactly once).
  - Register in `handler.ts`: `["POST /api/v1/apps", handleCreateApp]`.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): app registration endpoint (POST /api/v1/apps)`

---

### Task 7: `GET /oauth/authorize`

**Files:**

- Create: `packages/mastodon-api/src/oauth-flow.ts`
- Modify: `packages/mastodon-api/src/handler.ts`
- Test: `packages/mastodon-api/src/oauth-flow.test.ts`

**Interfaces:**

- Consumes: `ApproveMastodonAuthorization`/`MastodonAuthorizationRequest` (Task 2), store (Task 4), `randomToken` (Task 3).
- Produces: `handleAuthorize(ctx: RouteContext): Promise<Response>` registered as `GET /oauth/authorize`. Also `OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"` (shared with Task 8's tests).

- [ ] **Step 1: Write failing tests:**
  - Unknown `client_id` or a `redirect_uri` not exactly matching a registered one → `400` Mastodon error (never a redirect — RFC 6749 §4.1.2.1).
  - `response_type` ≠ `code` → `302` to `redirect_uri` with `?error=unsupported_response_type&state=...`.
  - Approval-hook `Response` is returned unchanged (hook returning a `200` consent page).
  - On `{approved: true}`: `302` to `redirect_uri` with a `code` + echoed `state`; the code is redeemable in the store, bound to client/redirect/scope, expires at `now + 600`.
  - `scope` omitted → defaults to the app's registered scopes.
  - PKCE: `code_challenge` + `code_challenge_method=S256` recorded on the code; `code_challenge_method=plain` → redirect with `error=invalid_request`.
  - `redirect_uri=urn:ietf:wg:oauth:2.0:oob` → `200` HTML containing the code in the `<title>` and body (no redirect).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** in `oauth-flow.ts`:
  - Parse query params; `store.getClient(clientId)`; exact-match `redirect_uri` against the record's `metadata.redirect_uris` (typed extraction).
  - Build `MastodonAuthorizationRequest` (`clientName` from metadata, `scopes` split on spaces) and call `config.approveAuthorization(request, httpRequest)`.
  - On approval: `randomToken()` code, `saveCode({code, clientId, redirectUri, scope, codeChallenge: challenge ?? null, expiresAt: now + (config.authorizationCodeLifetimeSeconds ?? 600)})`, then redirect (`Location` with `code` + `state` when present) or the oob HTML page (`content-type: text/html`, code HTML-escaped — it is base64url, but escape anyway).
  - Error redirects carry `error` (+ `error_description`, `state`).

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): authorization endpoint with approval hook, PKCE, and oob support`

---

### Task 8: `POST /oauth/token` + client authentication

**Files:**

- Create: `packages/mastodon-api/src/auth.ts`
- Modify: `packages/mastodon-api/src/oauth-flow.ts`, `src/handler.ts`
- Test: extend `packages/mastodon-api/src/oauth-flow.test.ts`

**Interfaces:**

- Consumes: store, `sha256Hex`/`verifyPkceS256`/`timingSafeEqualHex`/`randomToken` (Task 3), `OWNER_ACCOUNT_ID` (Task 2).
- Produces:
  - `auth.ts`: `authenticateClient(params: URLSearchParams, headers: Headers, store: MastodonStore): Promise<ClientRecord | null>` — reads `client_id`/`client_secret` from the form body, or HTTP Basic; verifies `sha256Hex(secret)` against the stored hash with `timingSafeEqualHex`.
  - `handleToken(ctx: RouteContext): Promise<Response>` registered as `POST /oauth/token`. Success body: `{access_token, token_type: "Bearer", scope, created_at}` (seconds).

- [ ] **Step 1: Write failing tests:**
  - Full happy path: register app (Task 6 route) → authorize (Task 7 route) → `grant_type=authorization_code` with `client_id`/`client_secret`/`code`/`redirect_uri` → `200 {access_token, token_type: "Bearer", scope, created_at}`; the store then has a token row whose `tokenHash === await sha256Hex(access_token)`, `accountId === "1"`.
  - Replaying the same code → `400 {"error": "invalid_grant", …}`-style Mastodon error (single-use).
  - Wrong `client_secret` → `401`; wrong `redirect_uri` → `400`.
  - PKCE round trip: authorize with `code_challenge` (S256 of a verifier) → token with matching `code_verifier` succeeds; wrong verifier → `400`.
  - `grant_type=client_credentials` → `200` token with `accountId: null` in the store.
  - Basic-auth client credentials accepted.
  - `grant_type=password` → `400 unsupported_grant_type` shape.
  - JSON body accepted (Mastodon clients send both).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement:**
  - Body parsing: JSON or form → normalize to `URLSearchParams`.
  - `authorization_code`: `authenticateClient` → `store.redeemCode(code, now)` → checks: code's `clientId` matches, `redirectUri` exact match, `verifyPkceS256(code_verifier, codeChallenge)` when a challenge was recorded (missing verifier then → `400`). Mint `token = randomToken()`; `saveToken({tokenHash: await sha256Hex(token), clientId, scope: codeRecord.scope, accountId: OWNER_ACCOUNT_ID, createdAt: now, revoked: false})`.
  - `client_credentials`: same client auth + minting with `accountId: null`, `scope` from the request (default the app's registered scopes).
  - Errors use OAuth error codes in Mastodon's JSON shape: `{"error": "invalid_grant", "error_description": …}` with `400`/`401` — both Mastodon and RFC 6749 use this body for the token endpoint.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): token endpoint (authorization_code + client_credentials, PKCE, hashed opaque tokens)`

---

### Task 9: `POST /oauth/revoke`

**Files:**

- Modify: `packages/mastodon-api/src/oauth-flow.ts`, `src/handler.ts`
- Test: extend `packages/mastodon-api/src/oauth-flow.test.ts`

**Interfaces:**

- Consumes: `createRevocationHandler` (`@dwk/oauth`), `authenticateClient` (Task 8), `sha256Hex`.
- Produces: `handleRevoke(ctx: RouteContext)` registered as `POST /oauth/revoke`.

- [ ] **Step 1: Write failing tests:** revoking an issued token with valid client credentials → `200`, and the token no longer authenticates (store row `revoked: true`); unknown token still → `200` (RFC 7009); bad client credentials → `401`.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — per request, build `createRevocationHandler({ revokeToken: async (token) => store.revokeToken(await sha256Hex(token)), authenticate: async (request, clientId) => …authenticateClient over a cloned body… })` and delegate. (The `@dwk/oauth` handler owns method/form/`token`-required mechanics.)

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): revocation endpoint via @dwk/oauth RFC 7009 handler`

---

### Task 10: Bearer auth + `verify_credentials` (apps + accounts)

**Files:**

- Modify: `packages/mastodon-api/src/auth.ts`, `src/apps.ts`, `src/handler.ts`
- Create: `packages/mastodon-api/src/accounts.ts`
- Test: `packages/mastodon-api/src/accounts.test.ts` (+ extend `apps.test.ts`)

**Interfaces:**

- Consumes: store (Task 4), `entities` (Task 5), error helpers (Task 2).
- Produces in `auth.ts`:

```ts
/** null ⇒ missing/malformed/unknown/revoked bearer (caller returns invalidToken()). */
async function authenticateBearer(
  request: Request,
  store: MastodonStore,
): Promise<MastodonTokenRecord | null>;
```

Routes: `GET /api/v1/apps/verify_credentials` (any valid token, incl. client_credentials) → `applicationEntity` of the token's app (no secret); `GET /api/v1/accounts/verify_credentials` (account-bound token required) → `credentialAccountEntity` with counts from `config.backend?.account()` when present, else zeros.

- [ ] **Step 1: Write failing tests:** no/garbage/revoked bearer → `401 {"error": "The access token is invalid"}`; client_credentials token on `/api/v1/accounts/verify_credentials` → `422 {"error": "This method requires an authenticated user."}`; account token → full CredentialAccount JSON (assert exact body with zero counts and every required field, `id: "1"`, `acct: "owner"`); a config with a fake `backend` (`account: async () => ({counts: {followers: 2, following: 3, statuses: 5}})`) → those counts.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — `authenticateBearer`: parse `Authorization: Bearer <token>`, `sha256Hex`, `store.getToken`, reject revoked. `accounts.ts` hosts `handleVerifyAccountCredentials`; the apps counterpart lives in `apps.ts`.

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit** — `feat(mastodon-api): bearer authentication and verify_credentials endpoints`

---

### Task 11: Instance endpoints

**Files:**

- Create: `packages/mastodon-api/src/instance.ts`
- Modify: `packages/mastodon-api/src/handler.ts`
- Test: `packages/mastodon-api/src/instance.test.ts`

**Interfaces:**

- Consumes: `instanceV1Entity`/`instanceV2Entity` (Task 5).
- Produces: `GET /api/v1/instance` and `GET /api/v2/instance`, both public (no auth), host taken from `new URL(config.baseUrl).host`.

- [ ] **Step 1: Write failing tests:** exact bodies for both versions from the shared test config; `version` matches `/^4\.2\.0 \(compatible; dwk-workers\//`; v1 `urls` has no `streaming_api` key; both reachable without a token.

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** (thin wrappers over Task 5's serializers).
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `feat(mastodon-api): instance endpoints (v1 + v2) with compatibility version string`

---

### Task 12: Markers

**Files:**

- Create: `packages/mastodon-api/src/markers.ts`
- Modify: `packages/mastodon-api/src/handler.ts`
- Test: `packages/mastodon-api/src/markers.test.ts`

**Interfaces:**

- Consumes: store (Task 4), `markerEntity` (Task 5), `authenticateBearer` (Task 10).
- Produces: `GET /api/v1/markers?timeline[]=home&timeline[]=notifications` → `{home: {...}, notifications: {...}}` (only saved ones; unknown timeline names ignored); `POST /api/v1/markers` accepting form (`home[last_read_id]=123`) or JSON (`{"home": {"last_read_id": "123"}}`) → the saved markers object. Both require an account-bound token.

- [ ] **Step 1: Write failing tests:** GET before any save → `{}`; POST form then GET → persisted with `version: 1`, second POST bumps to `2`; JSON POST works; client_credentials token → `422`; no token → `401`; a POST naming only `notifications` leaves `home` untouched.

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** — parse `timeline[]` (also accept bare `timeline`) for GET; for POST, accept both body forms, only `home`/`notifications` keys, each with `last_read_id` string.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `feat(mastodon-api): marker persistence (saved read positions)`

---

### Task 13: Stub roster

**Files:**

- Create: `packages/mastodon-api/src/stubs.ts`
- Modify: `packages/mastodon-api/src/handler.ts`
- Test: `packages/mastodon-api/src/stubs.test.ts`

**Interfaces:**

- Consumes: `authenticateBearer` (Task 10).
- Produces: data-driven roster (design: grows without new code paths):

```ts
interface StubRoute {
  readonly path: string;
  /** Whether a valid bearer is required (custom_emojis is public). */
  readonly auth: boolean;
  readonly body: unknown;
}
export const STUB_ROUTES: readonly StubRoute[];
```

Roster (all `GET`, `200`): `/api/v1/filters` `[]`, `/api/v2/filters` `[]`, `/api/v1/lists` `[]`, `/api/v1/custom_emojis` `[]` (public), `/api/v1/announcements` `[]`, `/api/v1/follow_requests` `[]`, `/api/v1/conversations` `[]`, `/api/v1/favourites` `[]`, `/api/v1/bookmarks` `[]`, `/api/v1/preferences` `{"posting:default:visibility": "public", "posting:default:sensitive": false, "posting:default:language": null, "reading:expand:media": "default", "reading:expand:spoilers": false}`.

- [ ] **Step 1: Write failing tests:** iterate `STUB_ROUTES` asserting `200` + exact body with a valid token; `custom_emojis` works without a token; an authed roster path without a token → `401`; `/api/v1/push/subscription` stays `404` (explicit non-goal).

- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** — register roster entries into the route table at module setup.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `feat(mastodon-api): data-driven valid-but-empty stub roster`

---

### Task 14: Docs — package spec, spec index, root CLAUDE.md

**Files:**

- Create: `spec/packages/mastodon-api.md`
- Modify: `spec/README.md`, `CLAUDE.md`, `packages/mastodon-api/README.md` (flesh out if thin)

- [ ] **Step 1: Seed `spec/packages/mastodon-api.md`** from `spec/mastodon-client-api.md`: package role, the `MastodonBackend` seam contract, the phase-1 endpoint roster (functional + stubs) **with the per-field entity tables the design defers to this file** (Application, CredentialAccount, Instance v1/v2, Marker — exactly the fields Task 5 emits), the token model + DPoP-exception mitigations, storage schema, and a "Phase 2/3 (not yet implemented)" section pointing at #349/#350. Match the header style of `spec/packages/oauth.md`.
- [ ] **Step 2: Link it** from `spec/README.md`'s package-spec list (alphabetical position).
- [ ] **Step 3: Update root `CLAUDE.md`:** 26 → 27 publishable packages; add `@dwk/mastodon-api` to the endpoint-package lists (intro paragraph, "Package taxonomy", the workerd test-environment list); one sentence describing it (phase 1 shipped: app OAuth + identity; read surface tracked in #349) in the status paragraph.
- [ ] **Step 4: Commit** — `docs(mastodon-api): per-package spec and repo doc updates`

---

### Task 15: Catalog entry + changeset

**Files:**

- Modify: `catalog.json`
- Create: `.changeset/mastodon-api-phase-1.md`

- [ ] **Step 1: Add the worker entry** (after `activitypub`, matching its style):

```json
{
  "id": "mastodon-api",
  "package": "@dwk/mastodon-api",
  "displayName": "Fediverse client login",
  "description": "Log in with Mastodon-compatible apps (Pixelfed, Tusky) to browse this site's fediverse notifications and timeline.",
  "group": "social",
  "binding": { "kind": "settingsActivated" },
  "requires": ["activitypub"],
  "resources": [
    {
      "type": "durable-object",
      "binding": "ACTOR",
      "className": "ActivityPubObject",
      "sqlite": true
    },
    { "type": "d1", "binding": "AUTH_DB" }
  ],
  "routes": [
    {
      "path": "/api/v1/",
      "match": "prefix",
      "methods": ["GET", "POST"],
      "handler": "createActivitypubMastodonApi",
      "specificationURL": "https://docs.joinmastodon.org/api/"
    },
    {
      "path": "/api/v2/",
      "match": "prefix",
      "methods": ["GET"],
      "handler": "createActivitypubMastodonApi",
      "specificationURL": "https://docs.joinmastodon.org/api/"
    },
    {
      "path": "/oauth/authorize",
      "match": "exact",
      "methods": ["GET"],
      "handler": "createActivitypubMastodonApi",
      "authorityBinding": true
    },
    {
      "path": "/oauth/token",
      "match": "exact",
      "methods": ["POST"],
      "handler": "createActivitypubMastodonApi",
      "authorityBinding": true
    },
    {
      "path": "/oauth/revoke",
      "match": "exact",
      "methods": ["POST"],
      "handler": "createActivitypubMastodonApi"
    }
  ]
}
```

Note: `createActivitypubMastodonApi` is the composed adapter the design mounts; the export itself lands with phase 2 (#349) — same forward-reference pattern as the catalog naming `createSolidPodWebdav` (an export in `@dwk/solid-pod`, not the entry's own package). Say this in the PR body.

- [ ] **Step 2: Validate** — `pnpm catalog:check` → exits 0 (schema + no route-claim overlaps + the new package has a catalog decision). Also `pnpm test:catalog`.

- [ ] **Step 3: Changeset** `.changeset/mastodon-api-phase-1.md`:

```md
---
"@dwk/mastodon-api": minor
---

Add `@dwk/mastodon-api` — phase 1 of the Mastodon-compatible client API
(spec/mastodon-client-api.md, #348): app registration (`POST /api/v1/apps`),
Mastodon-shaped OAuth (`/oauth/authorize`, `/oauth/token` with
`authorization_code` + `client_credentials`, `/oauth/revoke`), instance
documents (v1 + v2), `verify_credentials` (apps + accounts), marker
persistence, and the valid-but-empty stub roster. Opaque SHA-256-hashed
bearer tokens in D1 (`AUTH_DB`) are the documented exception to the
DPoP-everywhere rule: read-only surface, isolated audience, revocable.
```

- [ ] **Step 4: Commit** — `feat(mastodon-api): catalog worker entry and release changeset`

---

### Task 16: Full gate + PR

- [ ] **Step 1: Run the full local CI gate in order:**

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test
```

Expected: all five pass (matches `.github/workflows/ci.yml`). Also `pnpm release:gate` (no stable packages affected — passes) and `pnpm catalog:check`.

- [ ] **Step 2: Push and open the PR** from `.github/PULL_REQUEST_TEMPLATE.md`, keeping `Summary` / `Packages affected` / `Checklist` headings verbatim; leave inapplicable checklist items unchecked with a one-line reason. Title (lands in git log via squash-merge):

```
feat(mastodon-api,oauth): mastodon client api phase 1 — app oauth flow, instance + verify_credentials (#348)
```

Body: closes #348, references `spec/mastodon-client-api.md` + #327; note the catalog forward-reference to `createActivitypubMastodonApi` (phase 2, #349) and that manual client acceptance (Pixelfed app / Tusky) needs a deployed mount, which arrives with the phase-2 conformance-target work.
