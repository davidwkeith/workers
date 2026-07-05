# `@dwk/safe-fetch` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the four near-duplicate SSRF-safe-fetch + capped-body-read
modules (`@dwk/webmention`, `@dwk/websub`, `@dwk/microsub`, `@dwk/vc`) into one
new package, `@dwk/safe-fetch`, migrate all four onto it, and route four
previously-unguarded infrastructure fetches (#215: `@dwk/vc`'s did:web
resolution, `@dwk/atproto-pds`'s PLC-directory calls and remote DID
resolution) through it too.

**Architecture:** New cross-standard reusable lib at `packages/safe-fetch/`
(pure, Node-testable, no Workers bindings — same tier as `@dwk/dpop`),
promoting `@dwk/webmention`'s copy (the most complete) as the base, with two
new generalizing options (`allowedSchemes`, `stripHeadersCrossOrigin`,
`logEvent`) and a new `safeFetchJson` convenience wrapper. Every migration
deletes the package-local copy it replaces — this plan does not leave any
duplicate code behind.

**Tech Stack:** TypeScript (strict), Vitest (Node environment for this
package), pnpm workspaces, Changesets (pre mode, tag `beta`).

## Global Constraints

- ESM-only, `"sideEffects": false`, exact-pinned deps, `workspace:*` for
  internal deps — see `CLAUDE.md` "Per-package layout & conventions."
- `strict` TypeScript via `tsconfig.base.json`; use `import type` for
  type-only imports; ESLint flags unused vars unless prefixed `_`.
- Formatting: Prettier, semicolons, double quotes, trailing commas (`all`),
  80-column width. Run `pnpm format` before committing each task; CI runs
  `pnpm format:check`.
- `index.ts` carries a doc comment stating the package's role and a
  `@see spec/packages/<name>.md` pointer, matching every other package.
- Every task must leave `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  and `pnpm build` green for at least the packages it touched (Task 14 runs
  the full suite at the end).
- Commit after every task (never batch two tasks into one commit).

---

### Task 1: Scaffold the `@dwk/safe-fetch` package

**Files:**

- Create: `packages/safe-fetch/package.json`
- Create: `packages/safe-fetch/tsconfig.json`
- Create: `packages/safe-fetch/tsconfig.build.json`
- Create: `packages/safe-fetch/vitest.config.ts`
- Create: `packages/safe-fetch/README.md`
- Modify: `conformance/status.json`

**Interfaces:**

- Produces: the package skeleton every later task in this plan writes into.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@dwk/safe-fetch",
  "version": "0.1.0-beta.1",
  "description": "SSRF-safe outbound fetch and capped body reads. Cross-standard reusable; no Workers runtime dependency.",
  "keywords": ["ssrf", "fetch", "security", "http", "redirect"],
  "type": "module",
  "license": "ISC",
  "author": "David W. Keith <me@dwk.io>",
  "homepage": "https://github.com/davidwkeith/workers/tree/main/packages/safe-fetch#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/davidwkeith/workers.git",
    "directory": "packages/safe-fetch"
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
  "dependencies": {
    "@dwk/log": "workspace:*"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `tsconfig.build.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"],
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@dwk/safe-fetch",
    environment: "node",
  },
});
```

- [ ] **Step 5: Create `README.md`**

```markdown
# @dwk/safe-fetch

SSRF-safe outbound fetch and capped body reads, shared across every `@dwk`
package that fetches an attacker- or user-supplied URL.

Provides:

- `safeFetch` / `safeFetchJson` — private/reserved-host blocking, bounded
  manual redirects with per-hop re-validation, a single overall timeout, and
  cross-origin credential-header stripping on redirect.
- `readBodyCapped` / `readBytesCapped` — a response body reader that refuses
  to buffer past a byte cap, ignoring a lying `Content-Length`.

See `spec/packages/safe-fetch.md` for the full contract.
```

- [ ] **Step 6: Add the `conformance/status.json` entry**

Open `conformance/status.json` and add a new entry to the `"packages"`
object, alphabetically after `"@dwk/rdf"` (matches the shape used by every
other reusable lib — `"standard": null`, empty `suites`, pending
integration):

```json
    "@dwk/safe-fetch": {
      "standard": null,
      "suites": {},
      "integration": {
        "status": "pending",
        "cases": []
      }
    },
```

- [ ] **Step 7: Verify the schema still validates and the workspace resolves**

Run: `pnpm install`
Expected: no errors; `packages/safe-fetch` appears in the pnpm workspace.

Run: `node -e "JSON.parse(require('fs').readFileSync('conformance/status.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 8: Commit**

```bash
git add packages/safe-fetch/package.json packages/safe-fetch/tsconfig.json packages/safe-fetch/tsconfig.build.json packages/safe-fetch/vitest.config.ts packages/safe-fetch/README.md conformance/status.json pnpm-lock.yaml
git commit -m "feat(safe-fetch): scaffold @dwk/safe-fetch package"
```

---

### Task 2: `body.ts` — capped body readers

**Files:**

- Create: `packages/safe-fetch/src/body.ts`
- Test: `packages/safe-fetch/src/body.test.ts`

**Interfaces:**

- Consumes: nothing (pure, only the DOM `Response`/`ReadableStream` types).
- Produces: `MAX_BODY_BYTES` (number, default `2 * 1024 * 1024`),
  `readBodyCapped(response: Response, maxBytes?: number): Promise<string | null>`,
  `readBytesCapped(response: Response, maxBytes?: number): Promise<Uint8Array | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { readBodyCapped, readBytesCapped, MAX_BODY_BYTES } from "./body.js";

describe("readBodyCapped", () => {
  it("returns the body text when under the cap", async () => {
    const response = new Response("hello world");
    expect(await readBodyCapped(response, 1024)).toBe("hello world");
  });

  it("rejects up front on a lying Content-Length over the cap", async () => {
    const response = new Response("small body", {
      headers: { "content-length": "999999999" },
    });
    expect(await readBodyCapped(response, 1024)).toBeNull();
  });

  it("aborts a streamed body once it exceeds the cap, ignoring a missing Content-Length", async () => {
    const chunk = new Uint8Array(600).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = new Response(stream);
    expect(await readBodyCapped(response, 1000)).toBeNull();
  });

  it("defaults to MAX_BODY_BYTES (2 MB) when no cap is given", async () => {
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
    const response = new Response("ok");
    expect(await readBodyCapped(response)).toBe("ok");
  });
});

describe("readBytesCapped", () => {
  it("returns the raw bytes when under the cap", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const bytes = await readBytesCapped(response, 1024);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null when the body exceeds the cap", async () => {
    const response = new Response(new Uint8Array(2000));
    expect(await readBytesCapped(response, 1024)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: FAIL — `Cannot find module './body.js'` (file doesn't exist yet).

- [ ] **Step 3: Implement `body.ts`**

Promoted from `packages/webmention/src/fetch.ts` (the text reader) with the
byte-returning variant from `packages/websub/src/fetch.ts` added alongside —
`@dwk/websub` needs bytes, not text, for its feed/content fetches.

```ts
/**
 * `@dwk/safe-fetch` — capped response body readers.
 *
 * Reading an attacker- or user-supplied URL's response body without a cap
 * risks buffering an unbounded payload against a Worker's 128 MB isolate
 * memory limit. These readers refuse a declared `Content-Length` over the
 * cap up front, then read the stream incrementally and abort the moment the
 * cap is exceeded — so a missing or lying `Content-Length` cannot force the
 * whole body into memory. See `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

/** Default cap on a fetched body (2 MB) when no explicit cap is given. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readChunks(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }

  const body = response.body;
  if (body === null) {
    try {
      const buffer = await response.arrayBuffer();
      return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Read a response body as text, refusing bodies larger than `maxBytes`.
 * Returns `null` when the body is too large or cannot be read.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string | null> {
  const bytes = await readChunks(response, maxBytes);
  if (bytes === null) {
    return null;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read a response body as a `Uint8Array`, refusing bodies larger than
 * `maxBytes`. Returns `null` when the body is too large or cannot be read.
 */
export async function readBytesCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array | null> {
  return readChunks(response, maxBytes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/safe-fetch/src/body.ts packages/safe-fetch/src/body.test.ts
git commit -m "feat(safe-fetch): add capped body readers"
```

---

### Task 3: `safe-fetch.ts` core — host validation

**Files:**

- Create: `packages/safe-fetch/src/safe-fetch.ts`
- Test: `packages/safe-fetch/src/safe-fetch.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SsrfReason`, `SsrfError`, `FetchLike`, `isPrivateOrReservedHost(hostname: string): boolean`,
  `assertPublicUrl(rawUrl: string, options?: { allowedSchemes?: readonly string[] }): URL`.
  (`safeFetch`/`safeFetchJson` are added on top of this file in Task 4/5 —
  this task only lands the host-validation half so its test surface lands
  first.)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
} from "./safe-fetch.js";

describe("isPrivateOrReservedHost", () => {
  it("blocks loopback addresses", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("127.255.255.254")).toBe(true);
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
  });

  it("blocks the link-local / cloud metadata range", () => {
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("169.254.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
  });

  it("blocks RFC 1918 private ranges", () => {
    expect(isPrivateOrReservedHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fd12:3456::1]")).toBe(true);
  });

  it("blocks 0.0.0.0, CGNAT, benchmark, multicast and reserved", () => {
    expect(isPrivateOrReservedHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("255.255.255.255")).toBe(true);
  });

  it("blocks the IPv4 documentation (TEST-NET) ranges", () => {
    expect(isPrivateOrReservedHost("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.51.100.1")).toBe(true);
    expect(isPrivateOrReservedHost("203.0.113.1")).toBe(true);
  });

  it("blocks IPv6 addresses that embed a private IPv4", () => {
    expect(isPrivateOrReservedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:8.8.8.8]")).toBe(false);
    expect(isPrivateOrReservedHost("[::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::169.254.169.254]")).toBe(true);
  });

  it("blocks site-local, multicast, and documentation IPv6", () => {
    expect(isPrivateOrReservedHost("[fec0::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[ff02::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[2001:db8::1]")).toBe(true);
  });

  it("blocks non-public hostnames", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("foo.localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("blocks names with a trailing dot (FQDN form)", () => {
    expect(isPrivateOrReservedHost("localhost.")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal.")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("example.com.")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700:4700::1111]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("returns the parsed URL for a public http(s) URL by default", () => {
    expect(assertPublicUrl("https://example.com/x").host).toBe("example.com");
    expect(assertPublicUrl("http://example.com/x").host).toBe("example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow(SsrfError);
  });

  it("restricts to allowedSchemes when given", () => {
    expect(() =>
      assertPublicUrl("http://example.com/x", { allowedSchemes: ["https:"] }),
    ).toThrow(SsrfError);
    expect(
      assertPublicUrl("https://example.com/x", { allowedSchemes: ["https:"] })
        .protocol,
    ).toBe("https:");
  });

  it("rejects a private host", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest")).toThrow(
      SsrfError,
    );
    expect(() => assertPublicUrl("http://127.0.0.1:8080/")).toThrow(SsrfError);
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(SsrfError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: FAIL — `Cannot find module './safe-fetch.js'`.

- [ ] **Step 3: Implement the host-validation half of `safe-fetch.ts`**

Promoted byte-for-byte from `packages/webmention/src/safe-fetch.ts` (the IPv4/
IPv6/hostname logic is unchanged), with `assertPublicUrl` gaining the
`allowedSchemes` option:

```ts
/**
 * `@dwk/safe-fetch` — SSRF-safe outbound fetch and capped body reads.
 *
 * Any package that fetches an attacker- or user-supplied URL — a Webmention
 * `source`, a WebSub `hub.callback`, a Microsub feed URL, a credential's
 * `statusListCredential`, a `did:web` host — needs the same guardrails: the
 * URL's host must not be able to point back at the Worker's own network
 * (loopback, the link-local cloud metadata IP `169.254.169.254`, RFC 1918
 * ranges, etc.), redirects must be re-validated hop by hop, and the whole
 * operation must be bounded by a timeout. This module is the single shared
 * choke point every `@dwk` package routes such a fetch through instead of
 * re-deriving its own copy.
 *
 * Host validation is purely syntactic on the URL host — DNS rebinding (a name
 * that resolves to a private IP) is out of scope, as the Workers runtime does
 * not expose name resolution to user code. See `spec/packages/safe-fetch.md`
 * and `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

/** A minimal, injectable `fetch` signature. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Default cap on redirect hops before a fetch is abandoned. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** Default overall timeout (ms) bounding a fetch, redirects included. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default `allowedSchemes` for {@link assertPublicUrl} / {@link safeFetch}. */
const DEFAULT_ALLOWED_SCHEMES = ["http:", "https:"] as const;

/** HTTP status codes that carry a `Location` we may follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Machine-readable cause of an {@link SsrfError}, suitable for logging as a
 * structured field (no free-text parsing required).
 */
export type SsrfReason =
  "invalid_url" | "disallowed_scheme" | "blocked_host" | "too_many_redirects";

/**
 * Raised when a request is refused on SSRF grounds (blocked host, disallowed
 * scheme, or too many redirects). Callers catch this exactly like a network
 * failure — a blocked attempt looks the same as an unreachable host — but
 * {@link safeFetch} logs it first (under the caller-supplied `logEvent`) so
 * the single most security-relevant event here still produces a signal.
 *
 * Carries the structured {@link reason} and, when known, the sanitized
 * {@link host} so a logger can record them as queryable fields.
 */
export class SsrfError extends Error {
  /** Machine-readable cause. */
  readonly reason: SsrfReason;
  /** The offending host (name plus any port), when one is known. */
  readonly host?: string;
  constructor(message: string, reason: SsrfReason, host?: string) {
    super(message);
    this.name = "SsrfError";
    this.reason = reason;
    this.host = host;
  }
}

/** Parse a canonical dotted-decimal IPv4 host into its four octets. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) {
    return null;
  }
  const octets: number[] = [];
  for (let group = 1; group <= 4; group++) {
    const part = match[group];
    if (part === undefined) {
      return null;
    }
    const octet = Number.parseInt(part, 10);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

/**
 * True when `octets` falls in a range that must never be fetched from inside
 * the Worker's network: this-network, loopback, link-local (incl. the cloud
 * metadata IP), the RFC 1918 private blocks, CGNAT, IETF protocol/benchmark
 * assignments, and the multicast/reserved/broadcast space.
 */
function isPrivateIPv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network", incl. 0.0.0.0)
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Parse an IPv6 host (brackets already stripped) into its eight 16-bit groups,
 * expanding `::` compression and any trailing embedded IPv4 literal. Returns
 * `null` when `host` is not a valid IPv6 address.
 */
function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) {
    return null;
  }
  let str = host;

  const v4Match = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(str);
  const v4Str = v4Match?.[1];
  if (v4Str !== undefined) {
    const v4 = parseIPv4(v4Str);
    if (v4 === null) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${str.slice(0, str.length - v4Str.length)}${hi}:${lo}`;
  }

  if (str.indexOf("::") !== str.lastIndexOf("::")) {
    return null;
  }

  const toGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups: number[] = [];
    for (const token of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) {
        return null;
      }
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  if (str.includes("::")) {
    const parts = str.split("::");
    const left = toGroups(parts[0] ?? "");
    const right = toGroups(parts[1] ?? "");
    if (left === null || right === null) {
      return null;
    }
    const missing = 8 - left.length - right.length;
    if (missing < 1) {
      return null;
    }
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const all = toGroups(str);
  if (all === null || all.length !== 8) {
    return null;
  }
  return all;
}

/**
 * True when `groups` (eight 16-bit values) is an IPv6 address that must never
 * be fetched: unspecified, loopback, link-local, site-local, unique-local,
 * multicast, the documentation prefix, or an address that embeds an IPv4
 * (IPv4-mapped `::ffff:0:0/96`, deprecated IPv4-compatible `::/96`, or NAT64
 * `64:ff9b::/96`) whose embedded IPv4 is itself private.
 */
function isPrivateIPv6(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1 loopback
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation

  const embeddedV4: [number, number, number, number] = [
    g6 >> 8,
    g6 & 0xff,
    g7 >> 8,
    g7 & 0xff,
  ];
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0x0000)
  ) {
    return isPrivateIPv4(embeddedV4);
  }
  if (
    first === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIPv4(embeddedV4);
  }
  return false;
}

/** Hostnames (non-IP) that are never public and must never be fetched. */
function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  );
}

/**
 * Decide whether a URL host is private, loopback, link-local, or otherwise
 * not safe to fetch from inside the Worker's network. Accepts the raw
 * `URL.hostname` form (IPv6 hosts may arrive wrapped in `[...]`).
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  if (hostname === "") {
    return true;
  }
  const host = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  ).replace(/\.$/, "");

  const v4 = parseIPv4(host);
  if (v4 !== null) {
    return isPrivateIPv4(v4);
  }
  const v6 = parseIPv6(host);
  if (v6 !== null) {
    return isPrivateIPv6(v6);
  }
  return isBlockedHostname(host);
}

/** Options for {@link assertPublicUrl}. */
export interface AssertPublicUrlOptions {
  /** Schemes to accept (default `["http:", "https:"]`). */
  readonly allowedSchemes?: readonly string[];
}

/**
 * Validate that `rawUrl` is a fetchable public URL, returning the parsed
 * {@link URL}. Throws {@link SsrfError} for an unparseable URL, a scheme not
 * in `options.allowedSchemes` (default `http:`/`https:`), or a
 * private/reserved host.
 */
export function assertPublicUrl(
  rawUrl: string,
  options?: AssertPublicUrlOptions,
): URL {
  const allowedSchemes = options?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${rawUrl}`, "invalid_url");
  }
  if (!allowedSchemes.includes(url.protocol)) {
    throw new SsrfError(
      `disallowed scheme: ${url.protocol}`,
      "disallowed_scheme",
      url.hostname,
    );
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    throw new SsrfError(
      `blocked host: ${url.hostname}`,
      "blocked_host",
      url.hostname,
    );
  }
  return url;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/safe-fetch/src/safe-fetch.ts packages/safe-fetch/src/safe-fetch.test.ts
git commit -m "feat(safe-fetch): add SSRF host validation"
```

---

### Task 4: `safeFetch` — the guarded fetch loop

**Files:**

- Modify: `packages/safe-fetch/src/safe-fetch.ts`
- Modify: `packages/safe-fetch/src/safe-fetch.test.ts`

**Interfaces:**

- Consumes: `FetchLike`, `assertPublicUrl`, `SsrfError`, `DEFAULT_MAX_REDIRECTS`,
  `DEFAULT_TIMEOUT_MS` from Task 3.
- Produces: `SafeFetchOptions`, `SafeFetchResult`,
  `safeFetch(doFetch: FetchLike, rawUrl: string, init: RequestInit, options?: SafeFetchOptions): Promise<SafeFetchResult>`.

- [ ] **Step 1: Append the failing tests to `safe-fetch.test.ts`**

```ts
import { vi } from "vitest";
import { safeFetch } from "./safe-fetch.js";

describe("safeFetch", () => {
  it("fetches a public URL and reports the final URL", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    const { response, url } = await safeFetch(
      doFetch,
      "https://example.com/a",
      { method: "GET" },
    );
    expect(await response.text()).toBe("ok");
    expect(url).toBe("https://example.com/a");
  });

  it("sends redirect:manual and a timeout signal to the underlying fetch", async () => {
    const doFetch = vi.fn<FetchLike>(async () => new Response("ok"));
    await safeFetch(doFetch, "https://example.com/", { method: "GET" });
    const init = doFetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("combines a caller-supplied signal with its own timeout", async () => {
    const doFetch = vi.fn<FetchLike>(async () => new Response("ok"));
    const controller = new AbortController();
    await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
      signal: controller.signal,
    });
    const init = doFetch.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(controller.signal);
  });

  it("rejects a blocked initial host", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(doFetch, "http://169.254.169.254/latest", { method: "GET" }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("respects a restricted allowedSchemes option", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://example.com/",
        { method: "GET" },
        { allowedSchemes: ["https:"] },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("follows a redirect to another public host, re-validating it", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) => {
      if (url === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/final" },
        });
      }
      return new Response("landed");
    });
    const { response, url } = await safeFetch(doFetch, "https://a.example/", {
      method: "GET",
    });
    expect(await response.text()).toBe("landed");
    expect(url).toBe("https://b.example/final");
  });

  it("blocks a redirect that points at an internal host", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) =>
      url === "https://public.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })
        : new Response("should not reach"),
    );
    await expect(
      safeFetch(doFetch, "https://public.example/", { method: "GET" }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative redirect against the current URL", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) =>
      url === "https://a.example/start"
        ? new Response(null, { status: 301, headers: { location: "/moved" } })
        : new Response("landed"),
    );
    const { url } = await safeFetch(doFetch, "https://a.example/start", {
      method: "GET",
    });
    expect(url).toBe("https://a.example/moved");
  });

  it("gives up after too many redirects", async () => {
    const doFetch: FetchLike = vi.fn(async (url) => {
      const next = new URL(url);
      next.pathname = `${next.pathname}x`;
      return new Response(null, {
        status: 302,
        headers: { location: next.toString() },
      });
    });
    await expect(
      safeFetch(
        doFetch,
        "https://loop.example/",
        { method: "GET" },
        { maxRedirects: 3 },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("returns a redirect response that lacks a Location header", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(null, { status: 302 }),
    );
    const { response } = await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
    });
    expect(response.status).toBe(302);
  });

  it("strips credential headers on a cross-origin redirect but keeps them same-origin", async () => {
    const seen: Headers[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push(new Headers(init?.headers as HeadersInit));
      if (url === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://a.example/same" },
        });
      }
      if (url === "https://a.example/same") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/cross" },
        });
      }
      return new Response("ok");
    });
    await safeFetch(doFetch, "https://a.example/", {
      method: "GET",
      headers: { authorization: "Bearer secret", accept: "text/html" },
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer secret");
    expect(seen[1]?.get("authorization")).toBe("Bearer secret");
    expect(seen[2]?.get("authorization")).toBeNull();
    expect(seen[2]?.get("accept")).toBe("text/html");
  });

  it("strips extra stripHeadersCrossOrigin headers on a cross-origin redirect", async () => {
    const seen: Headers[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push(new Headers(init?.headers as HeadersInit));
      return url === "https://a.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://b.example/cross" },
          })
        : new Response("ok");
    });
    await safeFetch(
      doFetch,
      "https://a.example/",
      { method: "GET", headers: { "x-hub-signature": "abc" } },
      { stripHeadersCrossOrigin: ["x-hub-signature"] },
    );
    expect(seen[1]?.get("x-hub-signature")).toBeNull();
  });

  it("preserves method and body across a redirect (no GET downgrade)", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body });
      return url === "https://wm.example/in"
        ? new Response(null, {
            status: 307,
            headers: { location: "https://wm.example/in2" },
          })
        : new Response(null, { status: 202 });
    });
    await safeFetch(doFetch, "https://wm.example/in", {
      method: "POST",
      body: "source=x&target=y",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe("source=x&target=y");
  });

  it("logs and counts under the caller-supplied logEvent on an SSRF block", async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const metrics = { count: vi.fn() };
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://127.0.0.1/",
        { method: "GET" },
        { logger, metrics, logEvent: "custom.ssrf.blocked" },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(logger.warn).toHaveBeenCalledWith(
      "custom.ssrf.blocked",
      expect.objectContaining({ reason: "blocked_host" }),
    );
    expect(metrics.count).toHaveBeenCalledWith(
      "custom.ssrf.blocked",
      expect.objectContaining({ reason: "blocked_host" }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: FAIL — `safeFetch is not a function`.

- [ ] **Step 3: Append `safeFetch` to `safe-fetch.ts`**

```ts
/** Tunables for {@link safeFetch} / {@link safeFetchJson}. */
export interface SafeFetchOptions extends AssertPublicUrlOptions {
  /** Maximum redirect hops to follow (default {@link DEFAULT_MAX_REDIRECTS}). */
  readonly maxRedirects?: number;
  /** Overall timeout in ms, redirects included (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Logger for SSRF blocks; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink for SSRF-block counters; defaults to a no-op (see `@dwk/log`). */
  readonly metrics?: Metrics;
  /** Stable event name to log/count an SSRF block under (default `"safe_fetch.ssrf.blocked"`). */
  readonly logEvent?: string;
  /**
   * Extra header names to strip on a cross-origin redirect hop, beyond the
   * base credential set (`authorization`, `cookie`, `cookie2`,
   * `proxy-authorization`, `set-cookie`).
   */
  readonly stripHeadersCrossOrigin?: readonly string[];
}

/** A completed {@link safeFetch}: the final response and the URL it came from. */
export interface SafeFetchResult {
  /** The final, non-redirect response. */
  readonly response: Response;
  /** The fully-resolved URL the response came from (the base for relative links). */
  readonly url: string;
}

const BASE_STRIP_HEADERS = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
  "set-cookie",
];

/**
 * Fetch `rawUrl` through `doFetch` with SSRF guardrails.
 *
 * The initial host and every redirect target are validated with
 * {@link assertPublicUrl}; redirects are followed manually (`redirect:
 * "manual"`) up to `maxRedirects` hops; and a single {@link AbortSignal.timeout},
 * combined with any signal already on `init` via `AbortSignal.any`, bounds the
 * whole chain. The request method, headers, and body from `init` are
 * preserved across hops — a redirected `POST` re-POSTs to the (re-validated)
 * new location rather than silently degrading to `GET`.
 *
 * @throws {SsrfError} when a host is blocked, a scheme is disallowed, or the
 * redirect cap is exceeded. Other failures (network, timeout) propagate as the
 * underlying fetch rejection. Callers treat any throw as "fetch failed".
 */
export async function safeFetch(
  doFetch: FetchLike,
  rawUrl: string,
  init: RequestInit,
  options?: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;
  const logEvent = options?.logEvent ?? "safe_fetch.ssrf.blocked";
  const stripHeaders = [
    ...BASE_STRIP_HEADERS,
    ...(options?.stripHeadersCrossOrigin ?? []),
  ];
  // Bound the chain with our own timeout, but don't clobber a caller's signal
  // (e.g. a worker-shutdown abort): combine them so either can cancel.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    init.signal != null
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

  try {
    let currentUrl = assertPublicUrl(rawUrl, options).toString();
    let currentInit: RequestInit = { ...init };
    for (let hop = 0; ; hop++) {
      const response = await doFetch(currentUrl, {
        ...currentInit,
        redirect: "manual",
        signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, url: currentUrl };
      }

      const location = response.headers.get("location");
      if (location === null || location === "") {
        return { response, url: currentUrl };
      }
      if (hop >= maxRedirects) {
        throw new SsrfError(
          `too many redirects (> ${maxRedirects})`,
          "too_many_redirects",
          new URL(currentUrl).host,
        );
      }

      const next = assertPublicUrl(
        new URL(location, currentUrl).toString(),
        options,
      );
      await response.body?.cancel().catch(() => undefined);

      if (currentInit.headers && new URL(currentUrl).origin !== next.origin) {
        const headers = new Headers(currentInit.headers as HeadersInit);
        for (const name of stripHeaders) {
          headers.delete(name);
        }
        currentInit = { ...currentInit, headers };
      }
      currentUrl = next.toString();
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      const fields = { reason: err.reason, host: err.host };
      logger.warn(logEvent, fields);
      metrics.count(logEvent, fields);
    }
    throw err;
  }
}
```

Add `Logger`/`Metrics` to the existing `@dwk/log` import at the top of the
file (it already imports `noopLogger`, `noopMetrics`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/safe-fetch/src/safe-fetch.ts packages/safe-fetch/src/safe-fetch.test.ts
git commit -m "feat(safe-fetch): add safeFetch guarded fetch loop"
```

---

### Task 5: `safeFetchJson`

**Files:**

- Create: `packages/safe-fetch/src/json.ts`
- Test: `packages/safe-fetch/src/json.test.ts`
- Modify: `packages/safe-fetch/src/index.ts` (created in this task)

**Interfaces:**

- Consumes: `FetchLike`, `SafeFetchOptions`, `safeFetch` from Task 4;
  `readBodyCapped`, `MAX_BODY_BYTES` from Task 2.
- Produces: `safeFetchJson(doFetch: FetchLike, rawUrl: string, init?: RequestInit, options?: SafeFetchOptions & { maxBodyBytes?: number }): Promise<unknown>`;
  the package's full public surface via `index.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { safeFetchJson } from "./json.js";
import { SsrfError, type FetchLike } from "./safe-fetch.js";

describe("safeFetchJson", () => {
  it("fetches and parses a JSON body", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(JSON.stringify({ hello: "world" })),
    );
    const result = await safeFetchJson(doFetch, "https://example.com/data");
    expect(result).toEqual({ hello: "world" });
  });

  it("throws on a non-ok response", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    await expect(
      safeFetchJson(doFetch, "https://example.com/data"),
    ).rejects.toThrow(/status/i);
  });

  it("throws when the body exceeds maxBodyBytes", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(JSON.stringify({ big: "x".repeat(2000) })),
    );
    await expect(
      safeFetchJson(doFetch, "https://example.com/data", undefined, {
        maxBodyBytes: 10,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("throws on invalid JSON", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("not json"));
    await expect(
      safeFetchJson(doFetch, "https://example.com/data"),
    ).rejects.toThrow();
  });

  it("propagates SsrfError for a blocked host", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("{}"));
    await expect(
      safeFetchJson(doFetch, "http://169.254.169.254/data"),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("respects allowedSchemes", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("{}"));
    await expect(
      safeFetchJson(doFetch, "http://example.com/data", undefined, {
        allowedSchemes: ["https:"],
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: FAIL — `Cannot find module './json.js'`.

- [ ] **Step 3: Implement `json.ts`**

```ts
/**
 * `@dwk/safe-fetch` — SSRF-safe fetch with a JSON convenience wrapper.
 *
 * @packageDocumentation
 */

import { readBodyCapped, MAX_BODY_BYTES } from "./body.js";
import {
  safeFetch,
  type FetchLike,
  type SafeFetchOptions,
} from "./safe-fetch.js";

/** Options for {@link safeFetchJson}, extending {@link SafeFetchOptions}. */
export interface SafeFetchJsonOptions extends SafeFetchOptions {
  /** Cap on the response body in bytes (default {@link MAX_BODY_BYTES}). */
  readonly maxBodyBytes?: number;
}

/**
 * Fetch `rawUrl` through `doFetch` with SSRF guardrails, a timeout, and a
 * capped body read, returning the parsed JSON body.
 *
 * @throws {SsrfError} when a host is blocked, the scheme isn't allowed, or
 * the redirect cap is exceeded. Throws a plain `Error` when the response is
 * not ok, the body exceeds the cap, or the body isn't valid JSON.
 */
export async function safeFetchJson(
  doFetch: FetchLike,
  rawUrl: string,
  init: RequestInit = { headers: { accept: "application/json" } },
  options?: SafeFetchJsonOptions,
): Promise<unknown> {
  const { response } = await safeFetch(doFetch, rawUrl, init, options);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`fetch failed: ${response.status}`);
  }
  const text = await readBodyCapped(
    response,
    options?.maxBodyBytes ?? MAX_BODY_BYTES,
  );
  if (text === null) {
    throw new Error("response body too large");
  }
  return JSON.parse(text) as unknown;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/safe-fetch`
Expected: PASS.

- [ ] **Step 5: Write `index.ts`**

```ts
/**
 * `@dwk/safe-fetch` — SSRF-safe outbound fetch and capped body reads.
 *
 * A pure, runtime-agnostic library: no Cloudflare bindings, no Workers
 * runtime dependency, unit-tests entirely under Node. Every `@dwk` package
 * that fetches an attacker- or user-supplied URL routes it through
 * {@link safeFetch} / {@link safeFetchJson} instead of re-deriving its own
 * SSRF guardrails.
 *
 * @see spec/packages/safe-fetch.md
 * @packageDocumentation
 */

export {
  isPrivateOrReservedHost,
  assertPublicUrl,
  safeFetch,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type SsrfReason,
  type AssertPublicUrlOptions,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safe-fetch.js";
export { safeFetchJson, type SafeFetchJsonOptions } from "./json.js";
export { readBodyCapped, readBytesCapped, MAX_BODY_BYTES } from "./body.js";
export type { Logger, Metrics } from "@dwk/log";
```

- [ ] **Step 6: Verify the package builds and typechecks standalone**

Run: `pnpm --filter @dwk/safe-fetch typecheck && pnpm --filter @dwk/safe-fetch build`
Expected: both succeed with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/safe-fetch/src/json.ts packages/safe-fetch/src/json.test.ts packages/safe-fetch/src/index.ts
git commit -m "feat(safe-fetch): add safeFetchJson and public index"
```

---

### Task 6: Changeset for the new package

**Files:**

- Create: `.changeset/safe-fetch-new-package.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks (release bookkeeping only).

- [ ] **Step 1: Write the changeset**

```markdown
---
"@dwk/safe-fetch": minor
---

Add `@dwk/safe-fetch` — SSRF-safe outbound fetch (`safeFetch`,
`safeFetchJson`) and capped body reads (`readBodyCapped`, `readBytesCapped`),
extracted from the near-duplicate copies in `@dwk/webmention`, `@dwk/websub`,
`@dwk/microsub`, and `@dwk/vc`.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/safe-fetch-new-package.md
git commit -m "chore: add changeset for @dwk/safe-fetch"
```

---

### Task 7: Migrate `@dwk/webmention`

**Files:**

- Delete: `packages/webmention/src/safe-fetch.ts`
- Delete: `packages/webmention/src/safe-fetch.test.ts`
- Delete: `packages/webmention/src/fetch.ts`
- Modify: `packages/webmention/src/verify.ts`
- Modify: `packages/webmention/src/discovery.ts`
- Modify: `packages/webmention/src/sender.ts`
- Modify: `packages/webmention/src/index.ts`
- Modify: `packages/webmention/package.json`
- Create: `.changeset/webmention-safe-fetch-migration.md`

**Interfaces:**

- Consumes: `safeFetch`, `readBodyCapped`, `FetchLike`, `SsrfError`,
  `isPrivateOrReservedHost`, `DEFAULT_MAX_REDIRECTS`, `DEFAULT_TIMEOUT_MS`,
  `SafeFetchOptions`, `SafeFetchResult`, `SsrfReason` from `@dwk/safe-fetch`
  (Task 5).
- Produces: no change to `@dwk/webmention`'s public API surface (the
  re-exports in `index.ts` keep the same names, just from a different
  upstream module).

- [ ] **Step 1: Add the dependency**

Edit `packages/webmention/package.json`:

```json
  "dependencies": {
    "@dwk/log": "workspace:*",
    "@dwk/safe-fetch": "workspace:*"
  }
```

- [ ] **Step 2: Update `verify.ts`**

Change:

```ts
import { readBodyCapped, type FetchLike } from "./fetch.js";
```

```ts
import { WebmentionLogEvent } from "./log.js";
```

to:

```ts
import { readBodyCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
import { WebmentionLogEvent } from "./log.js";
```

and delete the now-redundant `import { safeFetch } from "./safe-fetch.js";`
line. Then change the `safeFetch` call's options object:

```ts
      { logger, metrics },
```

to:

```ts
      { logger, metrics, logEvent: WebmentionLogEvent.SsrfBlocked },
```

- [ ] **Step 3: Update `discovery.ts`**

Change:

```ts
import { readBodyCapped, type FetchLike } from "./fetch.js";
import { safeFetch } from "./safe-fetch.js";
```

to:

```ts
import { readBodyCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
import { WebmentionLogEvent } from "./log.js";
```

and change the `safeFetch` call's options object:

```ts
      { logger, metrics },
```

to:

```ts
      { logger, metrics, logEvent: WebmentionLogEvent.SsrfBlocked },
```

- [ ] **Step 4: Update `sender.ts`**

Change:

```ts
import type { FetchLike } from "./fetch.js";
```

```ts
import { safeFetch } from "./safe-fetch.js";
```

to:

```ts
import { safeFetch, type FetchLike } from "@dwk/safe-fetch";
```

(the `WebmentionLogEvent` import is already present — see Task's grep notes)
and add `logEvent: WebmentionLogEvent.SsrfBlocked` to that file's `safeFetch`
options object the same way as Steps 2–3.

- [ ] **Step 5: Update `index.ts`**

Change:

```ts
export type { FetchLike } from "./fetch.js";
export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "./safe-fetch.js";
```

to:

```ts
export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "@dwk/safe-fetch";
```

Any other `from "./fetch.js"` import in `index.ts` for `type FetchLike` is now
covered by this single re-export block — remove the separate one.

- [ ] **Step 6: Delete the superseded files**

```bash
rm packages/webmention/src/safe-fetch.ts packages/webmention/src/safe-fetch.test.ts packages/webmention/src/fetch.ts
```

- [ ] **Step 7: Grep for any remaining local references**

Run: `grep -rn "\./safe-fetch\|\./fetch\.js" packages/webmention/src`
Expected: no output (every reference now points at `@dwk/safe-fetch`).

- [ ] **Step 8: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/webmention typecheck && pnpm --filter @dwk/webmention build && pnpm test --project @dwk/webmention`
Expected: all pass. (`@dwk/webmention`'s `MAX_BODY_BYTES` constant, used
explicitly at its `readBodyCapped(response)` call sites via the function's
default parameter, is unaffected since `@dwk/safe-fetch`'s default is also
2 MB — no call-site change needed there.)

- [ ] **Step 9: Write the changeset**

```markdown
---
"@dwk/webmention": patch
---

Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change.
```

- [ ] **Step 10: Commit**

```bash
git add packages/webmention/package.json packages/webmention/src/verify.ts packages/webmention/src/discovery.ts packages/webmention/src/sender.ts packages/webmention/src/index.ts .changeset/webmention-safe-fetch-migration.md pnpm-lock.yaml
git rm packages/webmention/src/safe-fetch.ts packages/webmention/src/safe-fetch.test.ts packages/webmention/src/fetch.ts
git commit -m "refactor(webmention): migrate to @dwk/safe-fetch"
```

---

### Task 8: Migrate `@dwk/websub`

**Files:**

- Delete: `packages/websub/src/safe-fetch.ts`
- Delete: `packages/websub/src/safe-fetch.test.ts`
- Delete: `packages/websub/src/fetch.ts`
- Delete: `packages/websub/src/fetch.test.ts`
- Modify: `packages/websub/src/verify.ts`
- Modify: `packages/websub/src/distribute.ts`
- Modify: `packages/websub/src/index.ts`
- Modify: `packages/websub/package.json`
- Create: `.changeset/websub-safe-fetch-migration.md`

**Interfaces:**

- Consumes: same `@dwk/safe-fetch` surface as Task 7, plus `readBytesCapped`
  (websub reads bytes, not text) and `stripHeadersCrossOrigin`.
- Produces: no public API change.

- [ ] **Step 1: Add the dependency**

Edit `packages/websub/package.json`:

```json
  "dependencies": {
    "@dwk/log": "workspace:*",
    "@dwk/safe-fetch": "workspace:*"
  }
```

- [ ] **Step 2: Update `verify.ts`**

Change:

```ts
import type { FetchLike } from "./fetch.js";
import { readBytesCapped } from "./fetch.js";
```

```ts
import { safeFetch } from "./safe-fetch.js";
```

to:

```ts
import { readBytesCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
```

(the `WebSubLogEvent` import is already present in this file). Then, for
**both** occurrences of the `safeFetch` call's options object in this file,
use `replace_all` to change:

```ts
      { logger, metrics },
```

to:

```ts
      {
        logger,
        metrics,
        logEvent: WebSubLogEvent.SsrfBlocked,
        stripHeadersCrossOrigin: ["x-hub-signature"],
      },
```

- [ ] **Step 3: Update `distribute.ts`**

Change:

```ts
import type { FetchLike } from "./fetch.js";
import { readBytesCapped } from "./fetch.js";
```

```ts
import { safeFetch } from "./safe-fetch.js";
```

to:

```ts
import { readBytesCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
```

(the `WebSubLogEvent` import is already present). Then, for **both**
occurrences of `{ logger, metrics },` in this file, apply the same
`replace_all` change as Step 2.

- [ ] **Step 4: Update `index.ts`**

Change:

```ts
export type { FetchLike } from "./fetch.js";
```

and the block ending `} from "./safe-fetch.js";` to re-export everything from
`@dwk/safe-fetch` in one block, matching Task 7 Step 5's pattern (same
symbol names: `safeFetch`, `assertPublicUrl`, `isPrivateOrReservedHost`,
`SsrfError`, `DEFAULT_MAX_REDIRECTS`, `DEFAULT_TIMEOUT_MS`, `FetchLike`,
`SafeFetchOptions`, `SafeFetchResult`, `SsrfReason`), plus add
`readBytesCapped` to whatever `fetch.js` was re-exporting from this file if
it was (check with `grep -n "readBytesCapped\|MAX_BODY_BYTES" packages/websub/src/index.ts`
first).

- [ ] **Step 5: Delete the superseded files**

```bash
rm packages/websub/src/safe-fetch.ts packages/websub/src/safe-fetch.test.ts packages/websub/src/fetch.ts packages/websub/src/fetch.test.ts
```

- [ ] **Step 6: Grep for any remaining local references**

Run: `grep -rn "\./safe-fetch\|\./fetch\.js" packages/websub/src`
Expected: no output.

- [ ] **Step 7: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/websub typecheck && pnpm --filter @dwk/websub build && pnpm test --project @dwk/websub`
Expected: all pass. Confirm the two existing SSRF/redirect tests in
`verify.test.ts`/`distribute.test.ts` (the "thin wiring" coverage the design
calls for) still pass unchanged — they exercise the public API, not the
internals that moved.

- [ ] **Step 8: Write the changeset**

```markdown
---
"@dwk/websub": patch
---

Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change.
```

- [ ] **Step 9: Commit**

```bash
git add packages/websub/package.json packages/websub/src/verify.ts packages/websub/src/distribute.ts packages/websub/src/index.ts .changeset/websub-safe-fetch-migration.md pnpm-lock.yaml
git rm packages/websub/src/safe-fetch.ts packages/websub/src/safe-fetch.test.ts packages/websub/src/fetch.ts packages/websub/src/fetch.test.ts
git commit -m "refactor(websub): migrate to @dwk/safe-fetch"
```

---

### Task 9: Migrate `@dwk/microsub`

**Files:**

- Delete: `packages/microsub/src/safe-fetch.ts`
- Delete: `packages/microsub/src/safe-fetch.test.ts`
- Delete: `packages/microsub/src/fetch.ts`
- Modify: `packages/microsub/src/discovery.ts`
- Modify: `packages/microsub/src/index.ts`
- Modify: `packages/microsub/package.json`
- Create: `.changeset/microsub-safe-fetch-migration.md`

**Interfaces:**

- Consumes: same `@dwk/safe-fetch` surface as Task 7 (`readBodyCapped`, not
  `readBytesCapped` — microsub parses feeds as text).
- Produces: no public API change.

- [ ] **Step 1: Add the dependency**

Edit `packages/microsub/package.json`:

```json
  "dependencies": {
    "@dwk/dpop": "workspace:*",
    "@dwk/indieauth": "workspace:*",
    "@dwk/log": "workspace:*",
    "@dwk/safe-fetch": "workspace:*"
  }
```

- [ ] **Step 2: Update `discovery.ts`**

Change:

```ts
import { readTextCapped, type FetchLike } from "./fetch.js";
import { parseHFeed } from "./hfeed.js";
import { parseFeed, type Jf2Entry } from "./jf2.js";
import { safeFetch } from "./safe-fetch.js";
```

to:

```ts
import { parseHFeed } from "./hfeed.js";
import { parseFeed, type Jf2Entry } from "./jf2.js";
import {
  readBodyCapped as readTextCapped,
  safeFetch,
  type FetchLike,
} from "@dwk/safe-fetch";
```

(aliasing keeps every existing `readTextCapped(...)` call site in this file
unchanged — no need to touch the two call sites that use it). Add the
`MicrosubLogEvent` import (there is none in this file today):

```ts
import { MicrosubLogEvent } from "./log.js";
```

Then, for **both** occurrences of `{ logger, metrics },` in the `safeFetch`
calls in this file, use `replace_all` to change to:

```ts
      { logger, metrics, logEvent: MicrosubLogEvent.SsrfBlocked },
```

- [ ] **Step 3: Update `index.ts`**

Replace the `export { ... } from "./safe-fetch.js";` block and the
`export type { FetchLike } from "./fetch.js";` line with the single
`@dwk/safe-fetch` re-export block from Task 7 Step 5 (same symbol list).

- [ ] **Step 4: Delete the superseded files**

```bash
rm packages/microsub/src/safe-fetch.ts packages/microsub/src/safe-fetch.test.ts packages/microsub/src/fetch.ts
```

- [ ] **Step 5: Grep for any remaining local references**

Run: `grep -rn "\./safe-fetch\|\./fetch\.js" packages/microsub/src`
Expected: no output.

- [ ] **Step 6: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/microsub typecheck && pnpm --filter @dwk/microsub build && pnpm test --project @dwk/microsub`
Expected: all pass.

- [ ] **Step 7: Write the changeset**

```markdown
---
"@dwk/microsub": patch
---

Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change.
```

- [ ] **Step 8: Commit**

```bash
git add packages/microsub/package.json packages/microsub/src/discovery.ts packages/microsub/src/index.ts .changeset/microsub-safe-fetch-migration.md pnpm-lock.yaml
git rm packages/microsub/src/safe-fetch.ts packages/microsub/src/safe-fetch.test.ts packages/microsub/src/fetch.ts
git commit -m "refactor(microsub): migrate to @dwk/safe-fetch"
```

---

### Task 10: Migrate `@dwk/vc`'s status-list fetch

**Files:**

- Delete: `packages/vc/src/safe-fetch.ts`
- Delete: `packages/vc/src/safe-fetch.test.ts`
- Modify: `packages/vc/src/handler.ts`
- Modify: `packages/vc/package.json`
- Create: `.changeset/vc-safe-fetch-migration.md`

**Interfaces:**

- Consumes: `safeFetchJson`, `SsrfError` from `@dwk/safe-fetch`.
- Produces: no public API change (the deleted `safe-fetch.ts` was never
  re-exported from `@dwk/vc`'s `index.ts` — confirm with
  `grep -n "safe-fetch" packages/vc/src/index.ts` before deleting; if it
  _is_ exported, re-export the same names from `@dwk/safe-fetch` instead,
  matching Task 7 Step 5's pattern).

- [ ] **Step 1: Check whether `index.ts` re-exports the local module**

Run: `grep -n "safe-fetch" packages/vc/src/index.ts`
If it prints a re-export block, update it to import from `@dwk/safe-fetch`
instead (same pattern as Task 7 Step 5) before continuing. If it prints
nothing, no `index.ts` change is needed.

- [ ] **Step 2: Add the dependency**

Edit `packages/vc/package.json`:

```json
  "dependencies": {
    "@dwk/log": "workspace:*",
    "@dwk/safe-fetch": "workspace:*"
  }
```

- [ ] **Step 3: Update `handler.ts`**

Find the current import (check with
`grep -n "from \"\./safe-fetch" packages/vc/src/handler.ts`) — it imports
`safeFetchJson` and `SsrfError` from `./safe-fetch.js`. Change it to:

```ts
import { safeFetchJson, SsrfError } from "@dwk/safe-fetch";
```

Then update the call site (found in this task's research at
`packages/vc/src/handler.ts` around the status-list fetch) from:

```ts
const listCred = (await safeFetchJson(listCredential, {
  logger: config.logger,
  metrics: config.metrics,
  logEvent: VcLogEvent.SsrfBlocked,
})) as JsonObject;
```

to (the shared `safeFetchJson` takes `doFetch` as its first argument, unlike
the vc-local one which defaulted to the global `fetch` internally):

```ts
const listCred = (await safeFetchJson(
  globalThis.fetch.bind(globalThis),
  listCredential,
  { headers: { accept: "application/json" } },
  {
    allowedSchemes: ["https:"],
    maxBodyBytes: 1_048_576,
    logger: config.logger,
    metrics: config.metrics,
    logEvent: VcLogEvent.SsrfBlocked,
  },
)) as JsonObject;
```

- [ ] **Step 4: Delete the superseded files**

```bash
rm packages/vc/src/safe-fetch.ts packages/vc/src/safe-fetch.test.ts
```

- [ ] **Step 5: Grep for any remaining local references**

Run: `grep -rn "\./safe-fetch" packages/vc/src`
Expected: no output.

- [ ] **Step 6: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/vc typecheck && pnpm --filter @dwk/vc build && pnpm test --project @dwk/vc`
Expected: all pass. `handler.test.ts`'s existing status-list SSRF/timeout/
body-cap coverage (added in #232) should still pass since the observable
behavior (https-only, 1 MB cap, same `logEvent`) is unchanged — only the
module it's implemented in moved.

- [ ] **Step 7: Write the changeset**

```markdown
---
"@dwk/vc": patch
---

Move the status-list SSRF-safe fetch onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change and no
behavior change (still https-only, 1 MB body cap, same `vc.ssrf.blocked`
log event).
```

- [ ] **Step 8: Commit**

```bash
git add packages/vc/package.json packages/vc/src/handler.ts .changeset/vc-safe-fetch-migration.md pnpm-lock.yaml
git rm packages/vc/src/safe-fetch.ts packages/vc/src/safe-fetch.test.ts
git commit -m "refactor(vc): migrate status-list fetch to @dwk/safe-fetch"
```

---

### Task 11: Fold in #215 — `@dwk/vc`'s `did-web.ts` resolver

**Files:**

- Modify: `packages/vc/src/did-web.ts`
- Modify: `packages/vc/src/did-web.test.ts`
- Modify: `.changeset/vc-safe-fetch-migration.md` (bump to `minor` — see Step 5)

**Interfaces:**

- Consumes: `safeFetchJson`, `SsrfError` from `@dwk/safe-fetch`.
- Produces: `DidWebResolverOptions.fetch` widens from the narrow
  `(input: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>`
  shape to `@dwk/safe-fetch`'s `FetchLike`
  (`(input: string, init?: RequestInit) => Promise<Response>`) — a public API
  widening for `@dwk/vc`, hence the `minor` bump in Step 5. This is a
  deliberate refinement of the design spec (which left the narrow type
  untouched via an adapter): the narrow type cannot carry the `headers`/
  `body` a `safeFetch` redirect needs to inspect, so an adapter is not
  possible without losing the redirect-following it exists to provide. Every
  package's `fetch` fakes already construct real `Response` objects (see
  Task 7-10's tests) — this brings `@dwk/vc`'s did:web tests in line with
  that convention.

- [ ] **Step 1: Read the current resolver and its type**

Run: `sed -n '205,275p' packages/vc/src/did-web.ts`
(Confirms the exact current text before editing — the resolver logic is
described in this task's Step 2 below.)

- [ ] **Step 2: Widen the type and route through `safeFetch`**

Replace:

```ts
/** A minimal `fetch` used to retrieve DID documents. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Options for {@link createDidWebResolver}. */
export interface DidWebResolverOptions {
  /** Override the fetch implementation (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
}

/**
 * Build a {@link VerificationMethodResolver} that resolves a `did:web`
 * verification-method id by fetching the controller's DID document over HTTPS
 * and locating the referenced method. Returns `undefined` for non-`did:web`
 * ids, fetch failures, and unknown methods — verification treats that as an
 * unresolvable key rather than throwing.
 */
export function createDidWebResolver(
  options: DidWebResolverOptions = {},
): (id: string) => Promise<VerificationMethod | undefined> {
  const fetchImpl =
    options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (fetchImpl === undefined) {
    throw new Error(
      "@dwk/vc: no fetch implementation available for did:web resolution",
    );
  }

  return async (id: string) => {
    const hashIndex = id.indexOf("#");
    const did = hashIndex === -1 ? id : id.slice(0, hashIndex);
    if (!did.startsWith(DID_WEB_PREFIX)) return undefined;

    let url: string;
    try {
      url = didWebToUrl(did);
    } catch {
      return undefined;
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/did+json, application/json" },
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;

    let document: unknown;
    try {
      document = await response.json();
    } catch {
      return undefined;
    }
```

with:

```ts
/** A minimal, injectable `fetch` signature (re-exported for callers). */
export type { FetchLike } from "@dwk/safe-fetch";

/** Options for {@link createDidWebResolver}. */
export interface DidWebResolverOptions {
  /** Override the fetch implementation (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
}

/**
 * Build a {@link VerificationMethodResolver} that resolves a `did:web`
 * verification-method id by fetching the controller's DID document over
 * HTTPS (through `@dwk/safe-fetch`'s SSRF guardrails and timeout) and
 * locating the referenced method. Returns `undefined` for non-`did:web` ids,
 * a blocked/failed fetch, or unknown methods — verification treats that as
 * an unresolvable key rather than throwing.
 */
export function createDidWebResolver(
  options: DidWebResolverOptions = {},
): (id: string) => Promise<VerificationMethod | undefined> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

  return async (id: string) => {
    const hashIndex = id.indexOf("#");
    const did = hashIndex === -1 ? id : id.slice(0, hashIndex);
    if (!did.startsWith(DID_WEB_PREFIX)) return undefined;

    let url: string;
    try {
      url = didWebToUrl(did);
    } catch {
      return undefined;
    }

    let document: unknown;
    try {
      document = await safeFetchJson(
        fetchImpl,
        url,
        { headers: { accept: "application/did+json, application/json" } },
        { allowedSchemes: ["https:"], logEvent: "vc.ssrf.blocked" },
      );
    } catch {
      return undefined;
    }
```

Add the import at the top of the file:

```ts
import { safeFetchJson, type FetchLike } from "@dwk/safe-fetch";
```

Note: `document` is now populated by the `try` block above instead of a
separate `response.json()` step — the code following this replaced block
(which validates `document` is a plain object and locates the verification
method) is unchanged and needs no further edit.

- [ ] **Step 3: Update `did-web.test.ts`'s two fakes to return real `Response` objects**

Change:

```ts
    const resolve = createDidWebResolver({
      fetch: async (url) => {
```

so the fake's body still returns whatever JSON it constructed today, but
wrapped as `new Response(JSON.stringify(doc))` instead of
`{ ok: true, status: 200, json: async () => doc }` — read the existing fake
first with `sed -n '130,155p' packages/vc/src/did-web.test.ts` and convert
both fakes (the success case and the `{ ok: false, status: 404, ... }` case
becomes `new Response("", { status: 404 })`) to real `Response` construction,
matching the pattern already used in `packages/webmention/src/safe-fetch.test.ts`
(e.g. `vi.fn<FetchLike>(async () => new Response("ok"))`).

- [ ] **Step 4: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/vc typecheck && pnpm --filter @dwk/vc build && pnpm test --project @dwk/vc`
Expected: all pass, including the two updated `did-web.test.ts` cases.

- [ ] **Step 5: Bump the vc changeset to `minor`**

Edit `.changeset/vc-safe-fetch-migration.md` (from Task 10):

```markdown
---
"@dwk/vc": minor
---

Move the status-list SSRF-safe fetch onto the shared `@dwk/safe-fetch`
package instead of a package-local copy (no behavior change). Also close a
gap where `createDidWebResolver`'s DID-document fetch had **no** SSRF
protection or timeout at all (#215) — it now goes through the same
`safeFetch` guardrails as the status-list fetch. `DidWebResolverOptions.fetch`
widens from a narrow `{ ok, status, json() }` shape to a full `Response`-
returning `FetchLike`, matching `@dwk/safe-fetch`'s type — a minor bump for
any caller supplying a custom fetch implementation.
```

- [ ] **Step 6: Commit**

```bash
git add packages/vc/src/did-web.ts packages/vc/src/did-web.test.ts .changeset/vc-safe-fetch-migration.md
git commit -m "fix(vc): route did:web resolution through @dwk/safe-fetch (#215)"
```

---

### Task 12: Fold in #215 — `@dwk/atproto-pds`'s `resolve.ts`

**Files:**

- Modify: `packages/atproto-pds/src/resolve.ts`
- Modify: `packages/atproto-pds/src/resolve.test.ts`
- Modify: `packages/atproto-pds/package.json`
- Create: `.changeset/atproto-pds-safe-fetch.md`

**Interfaces:**

- Consumes: `safeFetch`, `SsrfError` from `@dwk/safe-fetch`.
- Produces: `resolveDidDocument`'s `did:web` branch now goes through
  `safeFetch`; its `FetchLike` (imported from `./plc-directory.js`) is
  already the full-`Response` shape, so no type widening is needed here
  (unlike Task 11).

- [ ] **Step 1: Add the dependency**

Edit `packages/atproto-pds/package.json`:

```json
  "dependencies": {
    "@dwk/log": "workspace:*",
    "@dwk/safe-fetch": "workspace:*",
    "@noble/curves": "2.2.0"
  }
```

- [ ] **Step 2: Update `resolve.ts`**

Change:

```ts
import { decodeMultikey, type DecodedMultikey } from "./crypto.js";
import { resolvePlcDid, type FetchLike } from "./plc-directory.js";
```

to:

```ts
import { safeFetch } from "@dwk/safe-fetch";
import { decodeMultikey, type DecodedMultikey } from "./crypto.js";
import { resolvePlcDid, type FetchLike } from "./plc-directory.js";
```

Change:

```ts
const url = path
  ? `https://${host}/${path}/did.json`
  : `https://${host}/.well-known/did.json`;
const res = await fetchImpl(url);
if (!res.ok) {
  throw new Error(
    `resolve: did:web document fetch failed for ${did} (${res.status})`,
  );
}
return (await res.json()) as DidDocument;
```

to:

```ts
const url = path
  ? `https://${host}/${path}/did.json`
  : `https://${host}/.well-known/did.json`;
const { response } = await safeFetch(
  fetchImpl,
  url,
  { headers: { accept: "application/did+json, application/json" } },
  { allowedSchemes: ["https:"], logEvent: "atproto-pds.ssrf.blocked" },
);
if (!response.ok) {
  throw new Error(
    `resolve: did:web document fetch failed for ${did} (${response.status})`,
  );
}
return (await response.json()) as DidDocument;
```

Note this changes `resolveDidDocument`'s thrown-error behavior for a blocked
host: it now throws `SsrfError` (from `@dwk/safe-fetch`) instead of never
reaching the `!res.ok` check with an unreachable-host network error. Callers
of `resolveDidDocument`/`resolveSigningKey` already treat any thrown error
the same way (migration verification failure), so no caller changes are
needed — confirm with `grep -rn "resolveDidDocument\|resolveSigningKey" packages/atproto-pds/src --include=*.ts | grep -v test`.

- [ ] **Step 3: Add a test for the new SSRF block**

Read the existing `did:web` success-case test first with
`grep -n "did:web" packages/atproto-pds/src/resolve.test.ts` to match its
fake-`fetchImpl` style, then add:

```ts
import { SsrfError } from "@dwk/safe-fetch";

it("throws SsrfError when the did:web host is private", async () => {
  await expect(
    resolveDidDocument("did:web:169.254.169.254", {
      fetchImpl: async () => new Response("{}"),
    }),
  ).rejects.toBeInstanceOf(SsrfError);
});
```

- [ ] **Step 4: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/atproto-pds typecheck && pnpm --filter @dwk/atproto-pds build && pnpm test --project @dwk/atproto-pds`
Expected: all pass.

- [ ] **Step 5: Write the changeset**

```markdown
---
"@dwk/atproto-pds": patch
---

`resolveDidDocument`'s `did:web` fetch now goes through `@dwk/safe-fetch`
(#215): a bounded timeout and a private/reserved-host block where previously
there was neither.
```

- [ ] **Step 6: Commit**

```bash
git add packages/atproto-pds/package.json packages/atproto-pds/src/resolve.ts packages/atproto-pds/src/resolve.test.ts .changeset/atproto-pds-safe-fetch.md pnpm-lock.yaml
git commit -m "fix(atproto-pds): route did:web resolution through @dwk/safe-fetch (#215)"
```

---

### Task 13: Fold in #215 — `@dwk/atproto-pds`'s `plc-directory.ts`

**Files:**

- Modify: `packages/atproto-pds/src/plc-directory.ts`
- Modify: `packages/atproto-pds/src/plc-directory.test.ts`
- Modify: `.changeset/atproto-pds-safe-fetch.md` (extend the note)

**Interfaces:**

- Consumes: `safeFetch` from `@dwk/safe-fetch`.
- Produces: `submitPlcOperation`, `resolvePlcDid`, `fetchPlcData` each go
  through `safeFetch` (timeout + redirect handling) while keeping their
  existing public signatures unchanged.

- [ ] **Step 1: Read the current file in full**

Run: `cat packages/atproto-pds/src/plc-directory.ts`
(Already captured in this plan's research — the three exported functions
each call `fetchImpl(...)` directly, once each.)

- [ ] **Step 2: Route all three call sites through `safeFetch`**

Change:

```ts
import type { SignedPlcOperation } from "./plc.js";

/** The minimal `fetch` shape this client needs (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
```

to:

```ts
import { safeFetch } from "@dwk/safe-fetch";
import type { SignedPlcOperation } from "./plc.js";

/** The minimal `fetch` shape this client needs (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
```

Change `submitPlcOperation`'s body:

```ts
  const { base, fetchImpl } = resolve(options);
  const res = await fetchImpl(`${base}/${did}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
  if (!res.ok) {
```

to:

```ts
  const { base, fetchImpl } = resolve(options);
  const { response: res } = await safeFetch(
    fetchImpl,
    `${base}/${did}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(op),
    },
    { logEvent: "atproto-pds.ssrf.blocked" },
  );
  if (!res.ok) {
```

Change `resolvePlcDid`'s body:

```ts
const { base, fetchImpl } = resolve(options);
const res = await fetchImpl(`${base}/${did}`);
if (res.status === 404) return null;
```

to:

```ts
const { base, fetchImpl } = resolve(options);
const { response: res } = await safeFetch(
  fetchImpl,
  `${base}/${did}`,
  {},
  { logEvent: "atproto-pds.ssrf.blocked" },
);
if (res.status === 404) return null;
```

Change `fetchPlcData`'s body the same way:

```ts
const { base, fetchImpl } = resolve(options);
const res = await fetchImpl(`${base}/${did}/data`);
if (res.status === 404) return null;
```

to:

```ts
const { base, fetchImpl } = resolve(options);
const { response: res } = await safeFetch(
  fetchImpl,
  `${base}/${did}/data`,
  {},
  { logEvent: "atproto-pds.ssrf.blocked" },
);
if (res.status === 404) return null;
```

- [ ] **Step 3: Add a test confirming the timeout signal is wired**

Read the existing test file's fake style first with
`grep -n "fetchImpl:" packages/atproto-pds/src/plc-directory.test.ts`, then
add (matching that style):

```ts
it("sends a timeout signal on every directory call", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}"));
  await resolvePlcDid("did:plc:abc", { fetchImpl });
  expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});
```

- [ ] **Step 4: Typecheck, lint, and test**

Run: `pnpm install && pnpm --filter @dwk/atproto-pds typecheck && pnpm --filter @dwk/atproto-pds build && pnpm test --project @dwk/atproto-pds`
Expected: all pass. Existing 404/non-ok-response tests for all three
functions should be unaffected since `safeFetch`'s default `directoryUrl`
(`https://plc.directory`) is always a public host, so the SSRF guard is a
pass-through.

- [ ] **Step 5: Extend the atproto-pds changeset**

Edit `.changeset/atproto-pds-safe-fetch.md` to also mention the PLC
directory client:

```markdown
---
"@dwk/atproto-pds": patch
---

`resolveDidDocument`'s `did:web` fetch and all three PLC-directory calls
(`submitPlcOperation`, `resolvePlcDid`, `fetchPlcData`) now go through
`@dwk/safe-fetch` (#215): a bounded timeout and redirect handling where
previously there was neither.
```

- [ ] **Step 6: Commit**

```bash
git add packages/atproto-pds/src/plc-directory.ts packages/atproto-pds/src/plc-directory.test.ts .changeset/atproto-pds-safe-fetch.md
git commit -m "fix(atproto-pds): route PLC directory calls through @dwk/safe-fetch (#215)"
```

---

### Task 14: Documentation and full-suite verification

**Files:**

- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing (final housekeeping + verification task).

- [ ] **Step 1: Update the package count and reusable-libs list**

Change (`CLAUDE.md` lines 15–17):

```markdown
**Status: implemented, unreleased.** There are **23 publishable packages** — the
reusable libs (`@dwk/dpop`, `@dwk/rdf`, `@dwk/wac`, `@dwk/log`, `@dwk/ldn`,
`@dwk/http-signatures`, `@dwk/oauth`, `@dwk/calendar`, `@dwk/store`) and the
```

to:

```markdown
**Status: implemented, unreleased.** There are **24 publishable packages** — the
reusable libs (`@dwk/dpop`, `@dwk/rdf`, `@dwk/wac`, `@dwk/log`, `@dwk/ldn`,
`@dwk/http-signatures`, `@dwk/oauth`, `@dwk/calendar`, `@dwk/safe-fetch`,
`@dwk/store`) and the
```

(Also update every other place in `CLAUDE.md` that states an exact package
count in prose — search first: `grep -n "23 publishable\|24 publishable" CLAUDE.md`.)

- [ ] **Step 2: Update the "Cross-standard reusable libs" taxonomy bullet**

Change (`CLAUDE.md` lines 119–120):

```markdown
- **Cross-standard reusable libs** — `@dwk/rdf`, `@dwk/dpop`, `@dwk/log`,
  `@dwk/ldn`, `@dwk/http-signatures`, `@dwk/oauth`, `@dwk/calendar`. These MUST
```

to:

```markdown
- **Cross-standard reusable libs** — `@dwk/rdf`, `@dwk/dpop`, `@dwk/log`,
  `@dwk/ldn`, `@dwk/http-signatures`, `@dwk/oauth`, `@dwk/calendar`,
  `@dwk/safe-fetch`. These MUST
```

and add one sentence after the existing `@dwk/oauth` description (before the
`@dwk/calendar` sentence) introducing the new package:

```markdown
`@dwk/safe-fetch` is the SSRF-safe outbound fetch and capped-body-read
primitive shared by every package that fetches an attacker- or
user-supplied URL (`@dwk/webmention`, `@dwk/websub`, `@dwk/microsub`,
`@dwk/vc`, `@dwk/atproto-pds`).
```

- [ ] **Step 3: Update the "Pure libs run under Node" test-environment list**

Change (`CLAUDE.md` lines 214–216):

```markdown
- **Pure libs run under Node** (`environment: "node"`): `@dwk/dpop`, `@dwk/rdf`,
  `@dwk/wac`, `@dwk/log`, `@dwk/ldn`, `@dwk/http-signatures`, `@dwk/oauth`,
  `@dwk/calendar`, `@dwk/webfinger`, `@dwk/host-meta`. They take plain-data
```

to:

```markdown
- **Pure libs run under Node** (`environment: "node"`): `@dwk/dpop`, `@dwk/rdf`,
  `@dwk/wac`, `@dwk/log`, `@dwk/ldn`, `@dwk/http-signatures`, `@dwk/oauth`,
  `@dwk/calendar`, `@dwk/webfinger`, `@dwk/host-meta`, `@dwk/safe-fetch`. They
  take plain-data
```

- [ ] **Step 4: Run the full repo verification suite**

Run: `pnpm install && pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`
Expected: all five green, matching the CI order (lint → format:check →
typecheck → build → test).

- [ ] **Step 5: Run the release gate to confirm no regression**

Run: `pnpm release:gate`
Expected: passes (no package is at a stable `>=1.0.0` version yet, so the
gate is a no-op today, but this confirms `conformance/status.json`'s new
`@dwk/safe-fetch` entry didn't break schema validation).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add @dwk/safe-fetch to CLAUDE.md taxonomy"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec has a task —
  scaffolding (Task 1), `body.ts`/`safe-fetch.ts`/`json.ts`/`index.ts` (Tasks
  2–5), the new-package changeset (Task 6), all four consumer migrations
  (Tasks 7–10), all three #215 call sites (Tasks 11–13), and release/doc
  bookkeeping (Task 14).
- **Placeholder scan:** no TBD/TODO; every code step shows the actual
  before/after text, sourced from the real files read during planning.
- **Type consistency:** `SafeFetchOptions` (Task 4) extends
  `AssertPublicUrlOptions` (Task 3) so `allowedSchemes` flows through both
  `safeFetch` and `safeFetchJson` (Task 5) without redeclaration;
  `SafeFetchJsonOptions extends SafeFetchOptions` for the same reason. The
  `logEvent`/`stripHeadersCrossOrigin` field names are used identically
  across Tasks 4, 7, 8, 9, 10, 11.
- **Deviation from the approved design doc, called out explicitly:** Task 11
  widens `@dwk/vc`'s `DidWebResolverOptions.fetch` type instead of the
  adapter-wrapper approach the design spec sketched — the adapter turned out
  to be impossible once the exact narrow shape was inspected (it lacks
  `headers`/`body`, which `safeFetch`'s redirect logic needs). This bumps
  `@dwk/vc`'s changeset from `patch` to `minor`. Also new versus the spec:
  `body.ts` exports `readBytesCapped` alongside `readBodyCapped` (websub
  needs bytes, not text) — a straightforward inclusion of a primitive #216's
  own table already named, not a scope change.
