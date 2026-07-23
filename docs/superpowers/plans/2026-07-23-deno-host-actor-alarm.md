# Deno KV-Lease Actor + Alarm Emulation (`@dwk/deno-host`, issue #398) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #398 — a single-writer actor (host-contract §3.3) for
`@dwk/deno-host`, built on a per-request Deno KV lease, with a KV-indexed
alarm schedule and an in-memory WebSocket stub, per the design already
committed to `spec/packages/deno-host.md` ("Design: single-writer actor +
alarm emulation (issue #398)").

**Architecture:** Four new/extended modules in `packages/deno-host/src/`:
`kv-client.ts` (injected `DenoKvLike` seam), `lease.ts` (KV-CAS lease,
bounded-retry contention), `alarms.ts` (KV-indexed alarm schedule + poll
primitives), `durable-object.ts` (`createDurableObjectNamespace` tying the
lease, alarms, and #397's `createDurableSqlite` together, plus an in-memory
WebSocket stub). No new runtime dependencies — everything reaches its store
through an injected client, same as the #397 libSQL shims.

**Tech Stack:** TypeScript (strict), Vitest (`environment: "node"`, no
Miniflare), `node:sqlite`-backed test fakes (existing `test-harness.ts`
pattern), a new hand-rolled `FakeDenoKv` test double.

## Global Constraints

- **Runtime-agnostic:** no `node:` imports and no Deno globals in
  `src/kv-client.ts`, `src/lease.ts`, `src/alarms.ts`, `src/durable-object.ts`
  — only `src/test-harness.ts` may use `node:sqlite`/Node built-ins (it is
  excluded from the published build).
- **No new npm dependencies.** `DenoKvLike` is a structural interface this
  package defines itself, never an import of a `@deno/kv-types`-style
  package — same "zero runtime dependencies" rule #397 already established.
- ESM-only, `"sideEffects": false`, Node ≥22 floor (unchanged — no new
  package.json dependencies to pin).
- Prettier: semicolons, double quotes, trailing commas (`all`), 80-column
  width. Run `pnpm format` if a step's formatting is ambiguous.
- TypeScript strict (`noUncheckedIndexedAccess`, `noUnusedLocals`/
  `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`) — use
  `import type` for type-only imports; relative imports use explicit `.js`
  extensions (NodeNext resolution), matching every existing file in this
  package.
- Doc comments: a `/** ... */` module header stating the module's role plus
  `@see spec/packages/deno-host.md`, matching `client.ts`/`sql-storage.ts`.
  No comments beyond one-liners for non-obvious WHY — no restating WHAT the
  code does.
- Test environment: Node (`environment: "node"`), no Miniflare —
  `pnpm test --project @dwk/deno-host`.
- Commit messages: Conventional Commits, scope `(deno-host)`.
- Numeric defaults, exactly as specified in `spec/packages/deno-host.md`:
  lease `ttlMs` 30000, `leaseAcquireTimeoutMs` 5000, retry backoff starting
  at 50ms capped at 1000ms; alarm retry base 2000ms, max 6 retries (matching
  `@dwk/cf-shims`'s alarm defaults).
- `pollAlarms` is implemented as a **method** on the namespace object
  (`ns.pollAlarms({ now, batchSize })`), not a free function taking the
  namespace as a parameter as the design doc's illustrative sketch showed —
  a method avoids needing to expose `kv`/`className` as public namespace
  properties just for a free function to read them. This still satisfies
  the design intent ("an exported tick function the composing app wires to
  its own periodic trigger") — the package still never starts its own
  timer.

---

## Task 1: `DenoKvLike` client seam

**Files:**
- Create: `packages/deno-host/src/kv-client.ts`
- Modify: `packages/deno-host/src/index.ts`

**Interfaces:**
- Produces: `KvKeyPart`, `KvKey`, `DenoKvEntryLike<T>`, `DenoKvCheckLike`,
  `DenoKvCommitResultLike`, `DenoKvAtomicLike`, `DenoKvListSelectorLike`,
  `DenoKvLike` — consumed by every task below.

This is a pure type-definition file (no runtime logic), matching
`client.ts`'s precedent from #397 (which also has no dedicated test file —
it's exercised indirectly through the modules that use it). No TDD cycle
applies; typecheck is the verification.

- [ ] **Step 1: Write `kv-client.ts`**

```ts
/**
 * Injected Deno KV client seam (structural subset of `Deno.Kv`), backing the
 * KV-lease actor + alarm emulation (issue #398). The package never
 * constructs a `Deno.Kv` connection itself — the composing app injects one,
 * exactly like the libSQL seams in `client.ts`.
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

/** One key-part; `Deno.Kv` keys are arrays of these primitive types. */
export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

export interface DenoKvEntryLike<T = unknown> {
  readonly key: KvKey;
  readonly value: T;
  readonly versionstamp: string | null;
}

export interface DenoKvCheckLike {
  readonly key: KvKey;
  readonly versionstamp: string | null;
}

export interface DenoKvCommitResultLike {
  readonly ok: boolean;
  readonly versionstamp?: string;
}

export interface DenoKvAtomicLike {
  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike;
  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicLike;
  delete(key: KvKey): DenoKvAtomicLike;
  commit(): Promise<DenoKvCommitResultLike>;
}

export interface DenoKvListSelectorLike {
  readonly prefix: KvKey;
  readonly start?: KvKey;
  readonly end?: KvKey;
}

export interface DenoKvLike {
  get<T = unknown>(key: KvKey): Promise<DenoKvEntryLike<T>>;
  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }>;
  delete(key: KvKey): Promise<void>;
  list<T = unknown>(
    selector: DenoKvListSelectorLike,
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>>;
  atomic(): DenoKvAtomicLike;
}
```

- [ ] **Step 2: Add the exports to `index.ts`**

Add this block to `packages/deno-host/src/index.ts` (anywhere among the
existing `export { ... } from "./..."` statements):

```ts
export {
  type KvKeyPart,
  type KvKey,
  type DenoKvEntryLike,
  type DenoKvCheckLike,
  type DenoKvCommitResultLike,
  type DenoKvAtomicLike,
  type DenoKvListSelectorLike,
  type DenoKvLike,
} from "./kv-client.js";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dwk/deno-host typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/deno-host/src/kv-client.ts packages/deno-host/src/index.ts
git commit -m "feat(deno-host): add the DenoKvLike injected client seam (#398)"
```

---

## Task 2: KV test harness + per-id lease (`lease.ts`)

**Files:**
- Modify: `packages/deno-host/src/test-harness.ts`
- Create: `packages/deno-host/src/lease.ts`
- Test: `packages/deno-host/src/lease.test.ts`
- Modify: `packages/deno-host/src/index.ts`

**Interfaces:**
- Consumes: `DenoKvLike`, `KvKey`, `DenoKvEntryLike`, `DenoKvAtomicLike`,
  `DenoKvCommitResultLike` (Task 1).
- Produces: `FakeDenoKv` (test-only), `acquireLease(kv, key, options?):
  Promise<Lease>`, `releaseLease(kv, lease): Promise<void>`,
  `LeaseContendedError`, `Lease { key, versionstamp }`, `LeaseOptions {
  ttlMs?, acquireTimeoutMs? }` — consumed by Tasks 3–5.

- [ ] **Step 1: Add `FakeDenoKv` to `test-harness.ts`**

Append to `packages/deno-host/src/test-harness.ts` (keep the existing
libSQL fakes above it unchanged):

```ts
import type {
  DenoKvAtomicLike,
  DenoKvCheckLike,
  DenoKvCommitResultLike,
  DenoKvEntryLike,
  DenoKvLike,
  DenoKvListSelectorLike,
  KvKey,
  KvKeyPart,
} from "./kv-client.js";

interface FakeKvRecord {
  readonly key: KvKey;
  value: unknown;
  versionstamp: string;
  expiresAt: number | null;
}

function keyTypeRank(part: KvKeyPart): number {
  if (part instanceof Uint8Array) return 0;
  if (typeof part === "bigint") return 1;
  if (typeof part === "number") return 2;
  if (typeof part === "string") return 3;
  return 4; // boolean
}

function compareKeyPart(a: KvKeyPart, b: KvKeyPart): number {
  const ra = keyTypeRank(a);
  const rb = keyTypeRank(b);
  if (ra !== rb) return ra - rb;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  return 0;
}

function compareKeys(a: KvKey, b: KvKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareKeyPart(a[i] as KvKeyPart, b[i] as KvKeyPart);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function hasPrefix(key: KvKey, prefix: KvKey): boolean {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (compareKeyPart(key[i] as KvKeyPart, prefix[i] as KvKeyPart) !== 0) {
      return false;
    }
  }
  return true;
}

function keyToId(key: KvKey): string {
  return key
    .map((part) =>
      part instanceof Uint8Array
        ? `bytes:${Buffer.from(part).toString("hex")}`
        : `${typeof part}:${String(part)}`,
    )
    .join(" ");
}

/**
 * An in-memory `DenoKvLike` reproducing `Deno.Kv`'s documented atomic-CAS
 * semantics: `atomic().check(...)` compares the current versionstamp
 * exactly (including `null` for "must not exist"), `set`/`delete` only
 * apply if every check passes, and `expireIn` entries are pruned lazily on
 * access. Key comparison (used by `list`'s ordering/range) ranks by type
 * first (bytes < bigint < number < string < boolean) then by value —
 * sufficient for this package's own key shapes (string/number only); real
 * `Deno.Kv` ordering is a live-verification item, not something this fake
 * needs to match exactly (see spec/packages/deno-host.md).
 */
export class FakeDenoKv implements DenoKvLike {
  readonly #store = new Map<string, FakeKvRecord>();
  #version = 0;

  #nextVersionstamp(): string {
    this.#version += 1;
    return this.#version.toString().padStart(20, "0");
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, rec] of this.#store) {
      if (rec.expiresAt !== null && rec.expiresAt <= now) this.#store.delete(id);
    }
  }

  async get<T = unknown>(key: KvKey): Promise<DenoKvEntryLike<T>> {
    this.#prune();
    const rec = this.#store.get(keyToId(key));
    return {
      key,
      value: (rec?.value ?? null) as T,
      versionstamp: rec?.versionstamp ?? null,
    };
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }> {
    const versionstamp = this.#nextVersionstamp();
    this.#store.set(keyToId(key), {
      key,
      value,
      versionstamp,
      expiresAt: options?.expireIn != null ? Date.now() + options.expireIn : null,
    });
    return { versionstamp };
  }

  async delete(key: KvKey): Promise<void> {
    this.#store.delete(keyToId(key));
  }

  async *list<T = unknown>(
    selector: DenoKvListSelectorLike,
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>> {
    this.#prune();
    const matches: FakeKvRecord[] = [];
    for (const rec of this.#store.values()) {
      if (!hasPrefix(rec.key, selector.prefix)) continue;
      if (selector.start !== undefined && compareKeys(rec.key, selector.start) < 0) {
        continue;
      }
      if (selector.end !== undefined && compareKeys(rec.key, selector.end) >= 0) {
        continue;
      }
      matches.push(rec);
    }
    matches.sort((a, b) => compareKeys(a.key, b.key));
    const limited = options?.limit != null ? matches.slice(0, options.limit) : matches;
    for (const rec of limited) {
      yield { key: rec.key, value: rec.value as T, versionstamp: rec.versionstamp };
    }
  }

  atomic(): DenoKvAtomicLike {
    return new FakeDenoKvAtomic(this);
  }

  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _get(id: string): FakeKvRecord | undefined {
    this.#prune();
    return this.#store.get(id);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _write(id: string, rec: FakeKvRecord): void {
    this.#store.set(id, rec);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _delete(id: string): void {
    this.#store.delete(id);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _nextVersionstamp(): string {
    return this.#nextVersionstamp();
  }
}

type FakeKvOp =
  | { readonly type: "set"; readonly key: KvKey; readonly value: unknown; readonly expireIn?: number }
  | { readonly type: "delete"; readonly key: KvKey };

class FakeDenoKvAtomic implements DenoKvAtomicLike {
  readonly #kv: FakeDenoKv;
  readonly #checks: DenoKvCheckLike[] = [];
  readonly #ops: FakeKvOp[] = [];

  constructor(kv: FakeDenoKv) {
    this.#kv = kv;
  }

  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike {
    this.#checks.push(...checks);
    return this;
  }

  set(key: KvKey, value: unknown, options?: { expireIn?: number }): DenoKvAtomicLike {
    this.#ops.push({ type: "set", key, value, expireIn: options?.expireIn });
    return this;
  }

  delete(key: KvKey): DenoKvAtomicLike {
    this.#ops.push({ type: "delete", key });
    return this;
  }

  async commit(): Promise<DenoKvCommitResultLike> {
    for (const c of this.#checks) {
      const rec = this.#kv._get(keyToId(c.key));
      const actual = rec?.versionstamp ?? null;
      if (actual !== c.versionstamp) return { ok: false };
    }
    let versionstamp: string | undefined;
    for (const op of this.#ops) {
      const id = keyToId(op.key);
      if (op.type === "delete") {
        this.#kv._delete(id);
      } else {
        versionstamp = this.#kv._nextVersionstamp();
        this.#kv._write(id, {
          key: op.key,
          value: op.value,
          versionstamp,
          expiresAt: op.expireIn != null ? Date.now() + op.expireIn : null,
        });
      }
    }
    return { ok: true, versionstamp };
  }
}
```

- [ ] **Step 2: Write the failing test — `lease.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { acquireLease, releaseLease, LeaseContendedError } from "./lease.js";
import { FakeDenoKv } from "./test-harness.js";

describe("acquireLease/releaseLease (host-contract §3.3 rule 1)", () => {
  it("acquires an unheld lease and releases it", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const lease = await acquireLease(kv, key);
    expect((await kv.get(key)).versionstamp).not.toBeNull();
    await releaseLease(kv, lease);
    expect((await kv.get(key)).versionstamp).toBeNull();
  });

  it("throws LeaseContendedError when the lease is held past the acquire timeout", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    await acquireLease(kv, key, { ttlMs: 10_000 });
    await expect(
      acquireLease(kv, key, { acquireTimeoutMs: 120 }),
    ).rejects.toThrow(LeaseContendedError);
  });

  it("a second acquire succeeds once the first is released", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const first = await acquireLease(kv, key);
    const secondPromise = acquireLease(kv, key, { acquireTimeoutMs: 2000 });
    await releaseLease(kv, first);
    const second = await secondPromise;
    expect(second.versionstamp).toBeDefined();
  });

  it("release is a no-op once the lease expired and a new holder acquired it", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const first = await acquireLease(kv, key, { ttlMs: 20 });
    await new Promise((r) => setTimeout(r, 40)); // let it expire
    const second = await acquireLease(kv, key);
    await releaseLease(kv, first); // stale — must not delete `second`'s lease
    expect((await kv.get(key)).versionstamp).toBe(second.versionstamp);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test --project @dwk/deno-host lease`
Expected: FAIL — `Cannot find module './lease.js'` (or equivalent).

- [ ] **Step 4: Write `lease.ts`**

```ts
/**
 * Per-id lease over Deno KV atomic CAS — host-contract §3.3 rule 1 (per-id
 * single writer), issue #398. Acquired once per `fetch()`/`alarm()`
 * delivery and released after — see spec/packages/deno-host.md "Design:
 * single-writer actor + alarm emulation (issue #398)" for why per-request
 * rather than a renewed session lease, and why bounded-retry-then-fail
 * rather than unbounded waiting.
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";

export class LeaseContendedError extends Error {
  constructor(key: KvKey) {
    super(`lease contended: ${JSON.stringify(key)}`);
    this.name = "LeaseContendedError";
  }
}

export interface LeaseOptions {
  /** How long a held lease survives without release (crash safety net). */
  readonly ttlMs?: number;
  /** Total time to keep retrying an acquire before giving up. */
  readonly acquireTimeoutMs?: number;
}

export interface Lease {
  readonly key: KvKey;
  readonly versionstamp: string;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 50;
const RETRY_MAX_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the lease at `key`, retrying with capped exponential backoff
 * until `acquireTimeoutMs` elapses. Throws {@link LeaseContendedError} if
 * the timeout elapses without acquiring.
 */
export async function acquireLease(
  kv: DenoKvLike,
  key: KvKey,
  options: LeaseOptions = {},
): Promise<Lease> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  let attempt = 0;
  for (;;) {
    const result = await kv
      .atomic()
      .check({ key, versionstamp: null })
      .set(key, { holder: crypto.randomUUID() }, { expireIn: ttlMs })
      .commit();
    if (result.ok && result.versionstamp !== undefined) {
      return { key, versionstamp: result.versionstamp };
    }
    if (Date.now() >= deadline) {
      throw new LeaseContendedError(key);
    }
    const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt += 1;
    await delay(backoff);
  }
}

/**
 * Release a lease previously returned by {@link acquireLease}. A no-op if
 * the lease already expired and a different holder has since acquired it
 * (verified via the versionstamp captured at acquire time).
 */
export async function releaseLease(kv: DenoKvLike, lease: Lease): Promise<void> {
  await kv
    .atomic()
    .check({ key: lease.key, versionstamp: lease.versionstamp })
    .delete(lease.key)
    .commit();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test --project @dwk/deno-host lease`
Expected: PASS (4 tests). The timeout test takes ~150ms wall time (real
timers, no fake-timer setup needed) — that's expected, not a hang.

- [ ] **Step 6: Add the exports to `index.ts`**

```ts
export {
  acquireLease,
  releaseLease,
  LeaseContendedError,
  type Lease,
  type LeaseOptions,
} from "./lease.js";
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @dwk/deno-host typecheck`
Expected: no errors.

```bash
git add packages/deno-host/src/test-harness.ts packages/deno-host/src/lease.ts packages/deno-host/src/lease.test.ts packages/deno-host/src/index.ts
git commit -m "feat(deno-host): add the FakeDenoKv test harness and the KV-CAS lease (#398)"
```

---

## Task 3: KV-indexed alarm schedule (`alarms.ts`)

**Files:**
- Create: `packages/deno-host/src/alarms.ts`
- Test: `packages/deno-host/src/alarms.test.ts`
- Modify: `packages/deno-host/src/index.ts`

**Interfaces:**
- Consumes: `DenoKvLike`, `KvKey` (Task 1); `FakeDenoKv` (Task 2, test-only).
- Produces: `setAlarm(kv, className, idHex, epochMs): Promise<void>`,
  `getAlarm(kv, className, idHex): Promise<number | null>`,
  `deleteAlarm(kv, className, idHex): Promise<void>`,
  `scheduleRetry(kv, className, idHex, epochMs, retryCount): Promise<void>`
  (internal — not exported from `index.ts`, used by Task 5),
  `listDueAlarms(kv, className, now, limit): Promise<DueAlarmEntry[]>`
  (internal), `claimDueAlarm(kv, entry): Promise<boolean>` (internal),
  `DueAlarmEntry { key, versionstamp, idHex, retryCount }` — consumed by
  Task 5's `pollAlarms`/`#fireAlarm`.

- [ ] **Step 1: Write the failing test — `alarms.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  setAlarm,
  getAlarm,
  deleteAlarm,
  scheduleRetry,
  listDueAlarms,
  claimDueAlarm,
} from "./alarms.js";
import { FakeDenoKv } from "./test-harness.js";

describe("KV-indexed alarm schedule (host-contract §3.3 rule 2)", () => {
  it("getAlarm is null before any alarm is set", async () => {
    const kv = new FakeDenoKv();
    expect(await getAlarm(kv, "Pod", "abc")).toBeNull();
  });

  it("setAlarm then getAlarm round-trips the scheduled time", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(1000);
  });

  it("setAlarm replaces the previous due-index entry (single slot) and resets retryCount", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    await setAlarm(kv, "Pod", "abc", 2000);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(2000);
    const due = await listDueAlarms(kv, "Pod", 2000, 10);
    expect(due).toEqual([
      {
        key: ["dwk_alarm_due", "Pod", 2000, "abc"],
        versionstamp: expect.any(String),
        idHex: "abc",
        retryCount: 0,
      },
    ]);
  });

  it("deleteAlarm clears both index entries", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    await deleteAlarm(kv, "Pod", "abc");
    expect(await getAlarm(kv, "Pod", "abc")).toBeNull();
    expect(await listDueAlarms(kv, "Pod", 1000, 10)).toEqual([]);
  });

  it("deleteAlarm on an id with no alarm is a no-op", async () => {
    const kv = new FakeDenoKv();
    await expect(deleteAlarm(kv, "Pod", "abc")).resolves.toBeUndefined();
  });

  it("listDueAlarms returns entries at or before `now`, ordered by time, excludes later ones", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "b", 2000);
    await setAlarm(kv, "Pod", "a", 1000);
    await setAlarm(kv, "Pod", "c", 3000);
    const due = await listDueAlarms(kv, "Pod", 2000, 10);
    expect(due.map((e) => e.idHex)).toEqual(["a", "b"]);
  });

  it("listDueAlarms respects the batch limit", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "a", 1000);
    await setAlarm(kv, "Pod", "b", 1000);
    const due = await listDueAlarms(kv, "Pod", 1000, 1);
    expect(due).toHaveLength(1);
  });

  it("claimDueAlarm deletes the entry once, and fails a second concurrent claim", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    const [entry] = await listDueAlarms(kv, "Pod", 1000, 10);
    const firstClaim = await claimDueAlarm(kv, entry!);
    expect(firstClaim).toBe(true);
    const secondClaim = await claimDueAlarm(kv, entry!);
    expect(secondClaim).toBe(false);
    expect(await listDueAlarms(kv, "Pod", 1000, 10)).toEqual([]);
  });

  it("scheduleRetry preserves a custom retryCount", async () => {
    const kv = new FakeDenoKv();
    await scheduleRetry(kv, "Pod", "abc", 3000, 2);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(3000);
    const [entry] = await listDueAlarms(kv, "Pod", 3000, 10);
    expect(entry?.retryCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --project @dwk/deno-host alarms`
Expected: FAIL — `Cannot find module './alarms.js'`.

- [ ] **Step 3: Write `alarms.ts`**

```ts
/**
 * KV-indexed alarm schedule — host-contract §3.3 rule 2, issue #398.
 *
 * Alarms are indexed directly in KV (not inside the per-id SQLite file, as
 * `@dwk/cf-shims` does) so a poll can find due entries with one range scan
 * instead of opening every object's database.
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";

const DUE_PREFIX = "dwk_alarm_due";
const BY_ID_PREFIX = "dwk_alarm_by_id";

interface AlarmRecord {
  readonly epochMs: number;
  readonly retryCount: number;
}

function dueKey(className: string, epochMs: number, idHex: string): KvKey {
  return [DUE_PREFIX, className, epochMs, idHex];
}

function byIdKey(className: string, idHex: string): KvKey {
  return [BY_ID_PREFIX, className, idHex];
}

async function writeAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  record: AlarmRecord,
): Promise<void> {
  const existing = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  const atomic = kv.atomic();
  if (existing.versionstamp !== null) {
    atomic.delete(dueKey(className, existing.value.epochMs, idHex));
  }
  atomic
    .set(dueKey(className, record.epochMs, idHex), record)
    .set(byIdKey(className, idHex), record);
  const result = await atomic.commit();
  if (!result.ok) {
    throw new Error(`setAlarm: failed to write alarm for ${idHex}`);
  }
}

/**
 * Schedule (or replace) the single alarm for `idHex`. Always a fresh
 * schedule — `retryCount` resets to 0, matching the contract's single-slot
 * "a later call replaces" rule.
 */
export async function setAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  epochMs: number,
): Promise<void> {
  await writeAlarm(kv, className, idHex, { epochMs, retryCount: 0 });
}

/**
 * Reschedule after a throwing `alarm()` handler, preserving `retryCount` so
 * the next invocation receives the right `retryCount`/`isRetry`. Not part
 * of the public `@dwk/deno-host` surface — used internally by
 * `durable-object.ts`'s `#fireAlarm` (Task 5).
 */
export async function scheduleRetry(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  epochMs: number,
  retryCount: number,
): Promise<void> {
  await writeAlarm(kv, className, idHex, { epochMs, retryCount });
}

/** The currently scheduled time for `idHex`, or null if none is set. */
export async function getAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<number | null> {
  const entry = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  return entry.versionstamp === null ? null : entry.value.epochMs;
}

/** Clear the alarm for `idHex`, if any. */
export async function deleteAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<void> {
  const existing = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  if (existing.versionstamp === null) return;
  await kv
    .atomic()
    .delete(dueKey(className, existing.value.epochMs, idHex))
    .delete(byIdKey(className, idHex))
    .commit();
}

export interface DueAlarmEntry {
  readonly key: KvKey;
  readonly versionstamp: string;
  readonly idHex: string;
  readonly retryCount: number;
}

/** Range-scan due entries for `className` at or before `now`, oldest first. */
export async function listDueAlarms(
  kv: DenoKvLike,
  className: string,
  now: number,
  limit: number,
): Promise<DueAlarmEntry[]> {
  const out: DueAlarmEntry[] = [];
  const iter = kv.list<AlarmRecord>(
    {
      prefix: [DUE_PREFIX, className],
      end: [DUE_PREFIX, className, now + 1],
    },
    { limit },
  );
  for await (const entry of iter) {
    out.push({
      key: entry.key,
      versionstamp: entry.versionstamp as string,
      idHex: entry.key[3] as string,
      retryCount: entry.value.retryCount,
    });
  }
  return out;
}

/**
 * Atomically claim a due entry (found via {@link listDueAlarms}) so only
 * one concurrent poller fires it. Returns false if another poller already
 * claimed it first.
 */
export async function claimDueAlarm(
  kv: DenoKvLike,
  entry: { readonly key: KvKey; readonly versionstamp: string },
): Promise<boolean> {
  const result = await kv
    .atomic()
    .check({ key: entry.key, versionstamp: entry.versionstamp })
    .delete(entry.key)
    .commit();
  return result.ok;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --project @dwk/deno-host alarms`
Expected: PASS (9 tests).

- [ ] **Step 5: Add the exports to `index.ts`**

Only the public CRUD trio — `scheduleRetry`/`listDueAlarms`/`claimDueAlarm`
stay internal to the package (imported directly by `durable-object.ts` in
Task 5, not re-exported):

```ts
export { setAlarm, getAlarm, deleteAlarm, type DueAlarmEntry } from "./alarms.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @dwk/deno-host typecheck`
Expected: no errors.

```bash
git add packages/deno-host/src/alarms.ts packages/deno-host/src/alarms.test.ts packages/deno-host/src/index.ts
git commit -m "feat(deno-host): add the KV-indexed alarm schedule (#398)"
```

---

## Task 4: `createDurableObjectNamespace` — fetch dispatch + WebSockets

**Files:**
- Create: `packages/deno-host/src/durable-object.ts`
- Test: `packages/deno-host/src/durable-object.test.ts`
- Modify: `packages/deno-host/src/index.ts`

**Interfaces:**
- Consumes: `DenoKvLike`, `KvKey` (Task 1); `acquireLease`, `releaseLease`,
  `Lease`, `LeaseOptions`, `LeaseContendedError` (Task 2);
  `createDurableSqlite`, `DurableSqlite`, `SyncSqliteDatabaseLike` (#397,
  already in the package).
- Produces (this task — alarms are added on top in Task 5):
  `DenoDurableObjectId { toString(), equals(other), name? }`,
  `DenoDurableObjectState<Env> { id, storage, concurrencyGate,
  blockConcurrencyWhile(fn), acceptWebSocket(ws), getWebSockets() }`,
  `AlarmInvocationInfo { retryCount, isRetry }`, `DurableObject<Env> { ctx,
  env, alarm? }`, `DurableObjectClass<T>`, `DurableObjectNamespaceOptions<Env>
  { kv, className, env, getStorageClient, leaseTtlMs?,
  leaseAcquireTimeoutMs? }`, `DurableObjectNamespaceLike<T> { idFromName,
  idFromString, newUniqueId, get(id) }`, `createDurableObjectNamespace(ctor,
  options): DurableObjectNamespaceLike<T>` — consumed by Task 5 (which
  extends this same file) and Task 6.

- [ ] **Step 1: Write the failing test — `durable-object.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  createDurableObjectNamespace,
  DurableObject,
} from "./durable-object.js";
import { FakeDenoKv, createStrictSyncSqlite } from "./test-harness.js";

class CounterObject extends DurableObject<Record<string, never>> {
  async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO counter (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1",
    );
    const n = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT n FROM counter WHERE id = 1")
      .one().n;
    return new Response(String(n));
  }
}

describe("createDurableObjectNamespace (host-contract §3.3)", () => {
  it("dispatches fetch() and persists state across requests for the same id", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns = createDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: () => db,
    });
    const stub = ns.get(ns.idFromName("alice"));
    expect(await (await stub.fetch(new Request("http://x/"))).text()).toBe("1");
    expect(await (await stub.fetch(new Request("http://x/"))).text()).toBe("2");
  });

  it("idFromName is deterministic and distinct names hash differently", () => {
    const kv = new FakeDenoKv();
    const ns = createDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: () => createStrictSyncSqlite(),
    });
    expect(ns.idFromName("alice").toString()).toBe(ns.idFromName("alice").toString());
    expect(ns.idFromName("alice").toString()).not.toBe(ns.idFromName("bob").toString());
  });

  it("enforces single-writer across two namespaces sharing one KV, and releases the lease after completion", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class SlowObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        await gate;
        return new Response("done");
      }
    }
    const makeNs = (leaseAcquireTimeoutMs?: number) =>
      createDurableObjectNamespace(SlowObject, {
        kv,
        className: "Slow",
        env: {},
        getStorageClient: () => db,
        leaseAcquireTimeoutMs,
      });
    const ns1 = makeNs();
    const ns2 = makeNs(100);
    const id = ns1.idFromName("shared");
    const inFlight = ns1.get(id).fetch(new Request("http://x/"));
    await new Promise((r) => setTimeout(r, 10)); // let ns1 acquire the lease
    await expect(
      ns2.get(ns2.idFromName("shared")).fetch(new Request("http://x/")),
    ).rejects.toThrow("lease contended");
    releaseFirst();
    expect(await (await inFlight).text()).toBe("done");
    // The lease is now free — proves release() actually ran.
    expect(
      await (await ns2.get(ns2.idFromName("shared")).fetch(new Request("http://x/"))).text(),
    ).toBe("done");
  });

  it("dispatches accepted WebSocket events to the instance's overrides", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    type Listener = (event: Event) => void;
    function fakeWebSocket(): WebSocket & { fire(type: string, props?: Record<string, unknown>): void } {
      const listeners = new Map<string, Listener[]>();
      return {
        addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
          const list = listeners.get(type) ?? [];
          list.push(cb as Listener);
          listeners.set(type, list);
        },
        removeEventListener(type: string, cb: EventListenerOrEventListenerObject) {
          const list = listeners.get(type);
          if (list) listeners.set(type, list.filter((x) => x !== (cb as Listener)));
        },
        fire(type: string, props: Record<string, unknown> = {}) {
          for (const cb of listeners.get(type) ?? []) {
            cb({ type, ...props } as unknown as Event);
          }
        },
      } as unknown as WebSocket & { fire(type: string, props?: Record<string, unknown>): void };
    }

    const received: string[] = [];
    class SocketObject extends DurableObject<Record<string, never>> {
      async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === "/ws") {
          const ws = fakeWebSocket();
          this.ctx.acceptWebSocket(ws);
          const accepted = this.ctx.getWebSockets().length;
          ws.fire("message", { data: "hello" });
          ws.fire("close", { code: 1000, wasClean: true });
          const afterClose = this.ctx.getWebSockets().length;
          return new Response(JSON.stringify({ accepted, afterClose }));
        }
        return new Response("ok");
      }
      webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
        received.push(String(message));
      }
    }
    const ns = createDurableObjectNamespace(SocketObject, {
      kv,
      className: "Socket",
      env: {},
      getStorageClient: () => db,
    });
    const res = await ns.get(ns.idFromName("room")).fetch(new Request("http://x/ws"));
    expect(await res.json()).toEqual({ accepted: 1, afterClose: 0 });
    expect(received).toEqual(["hello"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --project @dwk/deno-host durable-object`
Expected: FAIL — `Cannot find module './durable-object.js'`.

- [ ] **Step 3: Write `durable-object.ts`**

```ts
/**
 * The single-writer actor: `createDurableObjectNamespace`, tying the KV
 * lease (lease.ts) and #397's `createDurableSqlite` into one per-id Durable
 * Object emulation — host-contract §3.3. Alarm emulation (rule 2) is added
 * on top of this in a follow-up change to this same file (issue #398).
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";
import {
  acquireLease,
  releaseLease,
  type Lease,
  type LeaseOptions,
} from "./lease.js";
import { createDurableSqlite, type DurableSqlite } from "./sql-storage.js";
import type { SyncSqliteDatabaseLike } from "./client.js";

/* ---------- id ---------- */

function fnv1a(seed: number, input: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Small, dependency-free synchronous hash for stable id derivation.
 * `idFromName` must be synchronous (matching real Cloudflare and
 * `@dwk/cf-shims`), and `crypto.subtle.digest` is async-only, so this is
 * not cryptographic — distribution/stability only, same rationale
 * `@dwk/cf-shims` had for using sha256.
 */
function hashToHex(input: string): string {
  let hex = "";
  for (let seed = 0; seed < 4; seed++) {
    hex += fnv1a(seed, input).toString(16).padStart(8, "0");
  }
  return hex;
}

export class DenoDurableObjectId {
  readonly #hex: string;
  readonly name?: string;

  constructor(hex: string, name?: string) {
    this.#hex = hex;
    this.name = name;
  }

  toString(): string {
    return this.#hex;
  }

  equals(other: { toString(): string }): boolean {
    return other != null && other.toString() === this.#hex;
  }
}

/* ---------- WebSockets ---------- */

interface HibernationHandlers {
  webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): unknown;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): unknown;
  webSocketError?(ws: WebSocket, error: unknown): unknown;
}

class SocketSet {
  readonly #sockets = new Set<WebSocket>();
  #owner?: HibernationHandlers;

  _setOwner(owner: HibernationHandlers): void {
    this.#owner = owner;
  }

  accept(ws: WebSocket): void {
    this.#sockets.add(ws);
    const onMessage = (event: Event): void => {
      const data = (event as unknown as { data: string | ArrayBuffer }).data;
      void this.#owner?.webSocketMessage?.(ws, data);
    };
    const onError = (event: Event): void => {
      const error = ((event ?? {}) as { error?: unknown }).error;
      void this.#owner?.webSocketError?.(ws, error);
    };
    const cleanup = (event?: Event): void => {
      if (!this.#sockets.delete(ws)) return;
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", cleanup);
      const { code, reason, wasClean } = (event ?? {}) as {
        code?: number;
        reason?: string;
        wasClean?: boolean;
      };
      void this.#owner?.webSocketClose?.(
        ws,
        code ?? 1000,
        reason ?? "",
        wasClean ?? true,
      );
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", cleanup);
  }

  list(): WebSocket[] {
    return [...this.#sockets];
  }
}

/* ---------- state ---------- */

// `_Env` is retained (unused in this class's own body — `DurableObject<Env>`
// below is what actually reads it) so `DenoDurableObjectState<Env>` keeps
// matching `DurableObject`'s `ctx` field type; underscore-prefixed per this
// repo's unused-identifier convention (CLAUDE.md "Conventions"), since
// `noUnusedLocals` flags an unused generic type parameter (TS6133).
export class DenoDurableObjectState<_Env = unknown> {
  readonly id: DenoDurableObjectId;
  readonly storage: DurableSqlite;
  readonly #sockets = new SocketSet();
  #concurrencyGate: Promise<unknown> = Promise.resolve();

  constructor(id: DenoDurableObjectId, storage: DurableSqlite) {
    this.id = id;
    this.storage = storage;
  }

  _setOwner(owner: HibernationHandlers): void {
    this.#sockets._setOwner(owner);
  }

  get concurrencyGate(): Promise<unknown> {
    return this.#concurrencyGate;
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#concurrencyGate.then(fn);
    this.#concurrencyGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  acceptWebSocket(ws: WebSocket): void {
    this.#sockets.accept(ws);
  }

  getWebSockets(): WebSocket[] {
    return this.#sockets.list();
  }
}

/* ---------- DurableObject base class ---------- */

export interface AlarmInvocationInfo {
  readonly retryCount: number;
  readonly isRetry: boolean;
}

export class DurableObject<Env = unknown> {
  protected ctx: DenoDurableObjectState<Env>;
  protected env: Env;

  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;

  constructor(ctx: DenoDurableObjectState<Env>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export type DurableObjectClass<T> = new (state: never, env: never) => T;

/* ---------- namespace ---------- */

export interface DurableObjectNamespaceOptions<Env> {
  readonly kv: DenoKvLike;
  readonly className: string;
  readonly env: Env;
  /** Per-id libSQL embedded-replica client; called once per id, cached for
   *  the process's lifetime alongside the constructed instance. */
  readonly getStorageClient: (idHex: string) => SyncSqliteDatabaseLike;
  readonly leaseTtlMs?: number;
  readonly leaseAcquireTimeoutMs?: number;
}

interface StubLike {
  fetch(request: Request): Promise<Response>;
}

interface Instance<T> {
  readonly object: T;
  readonly state: DenoDurableObjectState;
  chain: Promise<unknown>;
}

/**
 * A `DurableObjectNamespace` that routes `get(id).fetch(req)` to a per-id
 * `DurableObject` instance, serialised behind a KV lease (cross-process,
 * host-contract §3.3 rule 1) plus a local per-id promise chain
 * (same-process ordering).
 */
export class DurableObjectNamespaceLike<
  T extends { fetch(r: Request): Promise<Response> },
> {
  readonly #ctor: DurableObjectClass<T>;
  readonly #options: DurableObjectNamespaceOptions<unknown>;
  readonly #instances = new Map<string, Instance<T>>();
  readonly #leaseOptions: LeaseOptions;

  constructor(
    ctor: DurableObjectClass<T>,
    options: DurableObjectNamespaceOptions<unknown>,
  ) {
    this.#ctor = ctor;
    this.#options = options;
    this.#leaseOptions = {
      ttlMs: options.leaseTtlMs,
      acquireTimeoutMs: options.leaseAcquireTimeoutMs,
    };
  }

  idFromName(name: string): DenoDurableObjectId {
    return new DenoDurableObjectId(hashToHex(name), name);
  }

  idFromString(hex: string): DenoDurableObjectId {
    return new DenoDurableObjectId(hex);
  }

  newUniqueId(): DenoDurableObjectId {
    const random = `${Date.now()}:${Math.random()}:${Math.random()}`;
    return new DenoDurableObjectId(hashToHex(random));
  }

  get(id: DenoDurableObjectId): StubLike {
    return { fetch: (request: Request) => this.#dispatch(id, request) };
  }

  #leaseKey(idHex: string): KvKey {
    return ["dwk_lease", this.#options.className, idHex];
  }

  #materialize(id: DenoDurableObjectId): Instance<T> {
    const idHex = id.toString();
    let instance = this.#instances.get(idHex);
    if (instance === undefined) {
      const db = this.#options.getStorageClient(idHex);
      const storage = createDurableSqlite(db);
      const state = new DenoDurableObjectState(id, storage);
      const object = new this.#ctor(state as never, this.#options.env as never);
      state._setOwner(object as HibernationHandlers);
      instance = { object, state, chain: Promise.resolve() };
      this.#instances.set(idHex, instance);
    }
    return instance;
  }

  async #dispatch(id: DenoDurableObjectId, request: Request): Promise<Response> {
    const idHex = id.toString();
    // Annotated (not just inferred) so the `type Lease` import is used —
    // this file has no other textual reference to `Lease` until Task 5
    // adds `#fireAlarm`'s `let lease: Lease | undefined`, so `noUnusedLocals`
    // flags the import otherwise (TS6133).
    const lease: Lease = await acquireLease(
      this.#options.kv,
      this.#leaseKey(idHex),
      this.#leaseOptions,
    );
    try {
      const instance = this.#materialize(id);
      const run = instance.chain
        .then(() => instance.state.concurrencyGate)
        .then(() => instance.object.fetch(request));
      instance.chain = run.then(
        () => undefined,
        () => undefined,
      );
      return await run;
    } finally {
      await releaseLease(this.#options.kv, lease);
    }
  }
}

export function createDurableObjectNamespace<
  Env,
  T extends { fetch(r: Request): Promise<Response> },
>(
  ctor: DurableObjectClass<T>,
  options: DurableObjectNamespaceOptions<Env>,
): DurableObjectNamespaceLike<T> {
  return new DurableObjectNamespaceLike<T>(
    ctor,
    options as DurableObjectNamespaceOptions<unknown>,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --project @dwk/deno-host durable-object`
Expected: PASS (4 tests). The single-writer test takes ~10ms + the release
wait; no long sleeps.

- [ ] **Step 5: Add the exports to `index.ts`**

```ts
export {
  createDurableObjectNamespace,
  DurableObject,
  DenoDurableObjectId,
  DenoDurableObjectState,
  type DurableObjectClass,
  type DurableObjectNamespaceOptions,
  type AlarmInvocationInfo,
} from "./durable-object.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @dwk/deno-host typecheck`
Expected: no errors.

```bash
git add packages/deno-host/src/durable-object.ts packages/deno-host/src/durable-object.test.ts packages/deno-host/src/index.ts
git commit -m "feat(deno-host): add createDurableObjectNamespace — fetch dispatch + WebSockets (#398)"
```

---

## Task 5: Alarm firing (`pollAlarms`) on the namespace

**Files:**
- Modify: `packages/deno-host/src/durable-object.ts` (created in Task 4)
- Test: `packages/deno-host/src/durable-object-alarms.test.ts`
- Modify: `packages/deno-host/src/index.ts`

**Interfaces:**
- Consumes: `setAlarm`, `getAlarm`, `scheduleRetry`, `listDueAlarms`,
  `claimDueAlarm`, `DueAlarmEntry` (Task 3); everything from Task 4.
- Produces: `DenoDurableObjectStorage extends DurableSqlite { setAlarm,
  getAlarm, deleteAlarm }` (replaces `DurableSqlite` as `ctx.storage`'s
  type), `DurableObjectNamespaceLike.pollAlarms({ now?, batchSize? }):
  Promise<void>` — consumed by Task 6 (README/spec status updates only; no
  further code depends on this).

- [ ] **Step 1: Write the failing test — `durable-object-alarms.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createDurableObjectNamespace,
  DurableObject,
  type AlarmInvocationInfo,
} from "./durable-object.js";
import { setAlarm, getAlarm } from "./alarms.js";
import { FakeDenoKv, createStrictSyncSqlite } from "./test-harness.js";

describe("pollAlarms (host-contract §3.3 rule 2)", () => {
  let fireLog: Array<{ id: string; retryCount: number }>;
  let failOnce: Set<string>;

  beforeEach(() => {
    fireLog = [];
    failOnce = new Set();
  });

  class AlarmObject extends DurableObject<Record<string, never>> {
    async fetch(): Promise<Response> {
      return new Response("ok");
    }
    async alarm(info?: AlarmInvocationInfo): Promise<void> {
      const idHex = this.ctx.id.toString();
      fireLog.push({ id: idHex, retryCount: info?.retryCount ?? 0 });
      if (failOnce.delete(idHex)) throw new Error("boom");
    }
  }

  function makeNs(kv: FakeDenoKv, db = createStrictSyncSqlite()) {
    return createDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: () => db,
    });
  }

  it("fires a due alarm once, clearing its due-index entry", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: id.toString(), retryCount: 0 }]);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toHaveLength(1);
  });

  it("does not fire an alarm scheduled in the future", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 5000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([]);
    await ns.pollAlarms({ now: 5000 });
    expect(fireLog).toEqual([{ id: id.toString(), retryCount: 0 }]);
  });

  it("retries a throwing handler by scheduling a new due entry, then fires again with an incremented retryCount", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    const idHex = id.toString();
    failOnce.add(idHex);
    await setAlarm(kv, "AlarmObject", idHex, 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: idHex, retryCount: 0 }]);
    const retryAt = await getAlarm(kv, "AlarmObject", idHex);
    expect(retryAt).toBe(1000 + 2000); // base backoff for retryCount 0
    await ns.pollAlarms({ now: retryAt! });
    expect(fireLog).toEqual([
      { id: idHex, retryCount: 0 },
      { id: idHex, retryCount: 1 },
    ]);
  });

  it("a handler that sets a new alarm during its run supersedes the auto-retry", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    class SupersedeObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        return new Response("ok");
      }
      async alarm(): Promise<void> {
        await this.ctx.storage.setAlarm(9999);
        throw new Error("boom");
      }
    }
    const ns = createDurableObjectNamespace(SupersedeObject, {
      kv,
      className: "Supersede",
      env: {},
      getStorageClient: () => db,
    });
    const id = ns.idFromName("alice");
    await setAlarm(kv, "Supersede", id.toString(), 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(await getAlarm(kv, "Supersede", id.toString())).toBe(9999);
  });

  it("two namespaces sharing one KV only fire a due alarm once", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns1 = makeNs(kv, db);
    const ns2 = makeNs(kv, db);
    const id = ns1.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 1000);
    await Promise.all([ns1.pollAlarms({ now: 1000 }), ns2.pollAlarms({ now: 1000 })]);
    expect(fireLog).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --project @dwk/deno-host durable-object-alarms`
Expected: FAIL — `ns.pollAlarms is not a function`.

- [ ] **Step 3: Modify `durable-object.ts` — add the alarm import**

Find:

```ts
import { createDurableSqlite, type DurableSqlite } from "./sql-storage.js";
import type { SyncSqliteDatabaseLike } from "./client.js";
```

Replace with:

```ts
import { createDurableSqlite, type DurableSqlite } from "./sql-storage.js";
import type { SyncSqliteDatabaseLike } from "./client.js";
import {
  setAlarm,
  getAlarm,
  deleteAlarm as deleteAlarmKv,
  scheduleRetry,
  listDueAlarms,
  claimDueAlarm,
} from "./alarms.js";
```

- [ ] **Step 4: Modify `durable-object.ts` — add the storage wrapper**

Find (the `DenoDurableObjectId` class's closing brace and the WebSocket
section header immediately after it):

```ts
  equals(other: { toString(): string }): boolean {
    return other != null && other.toString() === this.#hex;
  }
}

/* ---------- WebSockets ---------- */
```

Replace with:

```ts
  equals(other: { toString(): string }): boolean {
    return other != null && other.toString() === this.#hex;
  }
}

/* ---------- storage ---------- */

export interface DenoDurableObjectStorage extends DurableSqlite {
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

function createStorage(
  db: SyncSqliteDatabaseLike,
  kv: DenoKvLike,
  className: string,
  idHex: string,
): DenoDurableObjectStorage {
  const base = createDurableSqlite(db);
  return {
    ...base,
    async setAlarm(scheduledTime: number | Date): Promise<void> {
      const time =
        typeof scheduledTime === "number"
          ? scheduledTime
          : scheduledTime.getTime();
      if (!Number.isFinite(time)) {
        throw new TypeError("setAlarm: scheduledTime must be a finite time");
      }
      await setAlarm(kv, className, idHex, time);
    },
    async getAlarm(): Promise<number | null> {
      return getAlarm(kv, className, idHex);
    },
    async deleteAlarm(): Promise<void> {
      await deleteAlarmKv(kv, className, idHex);
    },
  };
}

/* ---------- WebSockets ---------- */
```

(The storage wrapper's `deleteAlarm` method key does not collide with the
top-level `deleteAlarmKv` import — object literal method names are not
lexical bindings, so this is unambiguous. `deleteAlarmKv` is imported once,
in Step 3.)

- [ ] **Step 5: Modify `durable-object.ts` — change the state's storage type**

Find (note: Task 4's actual committed code uses `_Env`, not `Env` — its
type parameter is unused within the class body and TypeScript's
`noUnusedLocals` flags an unused generic type parameter, so Task 4's
implementer underscore-prefixed it; match whatever Task 4 actually
committed):

```ts
export class DenoDurableObjectState<_Env = unknown> {
  readonly id: DenoDurableObjectId;
  readonly storage: DurableSqlite;
  readonly #sockets = new SocketSet();
  #concurrencyGate: Promise<unknown> = Promise.resolve();

  constructor(id: DenoDurableObjectId, storage: DurableSqlite) {
```

Replace with:

```ts
export class DenoDurableObjectState<_Env = unknown> {
  readonly id: DenoDurableObjectId;
  readonly storage: DenoDurableObjectStorage;
  readonly #sockets = new SocketSet();
  #concurrencyGate: Promise<unknown> = Promise.resolve();

  constructor(id: DenoDurableObjectId, storage: DenoDurableObjectStorage) {
```

- [ ] **Step 6: Modify `durable-object.ts` — use the wrapper in `#materialize`**

Find:

```ts
      const db = this.#options.getStorageClient(idHex);
      const storage = createDurableSqlite(db);
      const state = new DenoDurableObjectState(id, storage);
```

Replace with:

```ts
      const db = this.#options.getStorageClient(idHex);
      const storage = createStorage(
        db,
        this.#options.kv,
        this.#options.className,
        idHex,
      );
      const state = new DenoDurableObjectState(id, storage);
```

- [ ] **Step 7: Modify `durable-object.ts` — add `pollAlarms`/`#fireAlarm`**

Find the end of the `#dispatch` method and the class's closing brace:

```ts
    } finally {
      await releaseLease(this.#options.kv, lease);
    }
  }
}

export function createDurableObjectNamespace<
```

Replace with:

```ts
    } finally {
      await releaseLease(this.#options.kv, lease);
    }
  }

  /**
   * One scan-and-fire pass over this namespace's due alarms. Wire this to
   * whatever periodic trigger the composing app's runtime offers
   * (`Deno.cron()` on Deno Deploy) — the package never starts its own
   * timer.
   */
  async pollAlarms(
    options: { now?: number; batchSize?: number } = {},
  ): Promise<void> {
    const now = options.now ?? Date.now();
    const batchSize = options.batchSize ?? 100;
    const due = await listDueAlarms(
      this.#options.kv,
      this.#options.className,
      now,
      batchSize,
    );
    for (const entry of due) {
      const claimed = await claimDueAlarm(this.#options.kv, entry);
      if (!claimed) continue;
      await this.#fireAlarm(entry.idHex, entry.retryCount, now);
    }
  }

  async #fireAlarm(
    idHex: string,
    retryCount: number,
    now: number,
  ): Promise<void> {
    const id = new DenoDurableObjectId(idHex);
    let lease: Lease | undefined;
    try {
      lease = await acquireLease(
        this.#options.kv,
        this.#leaseKey(idHex),
        this.#leaseOptions,
      );
      const instance = this.#materialize(id);
      const run = instance.chain
        .then(() => instance.state.concurrencyGate)
        .then(async () => {
          const handler = (
            instance.object as {
              alarm?: (info: AlarmInvocationInfo) => void | Promise<void>;
            }
          ).alarm;
          if (typeof handler !== "function") return;
          await handler.call(instance.object, {
            retryCount,
            isRetry: retryCount > 0,
          });
        });
      instance.chain = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
    } catch {
      // Exhausted retries are dropped; the handler owns its error
      // reporting (same posture as @dwk/cf-shims' alarm shim).
      if (retryCount < ALARM_RETRY_MAX) {
        const stillPending = await getAlarm(
          this.#options.kv,
          this.#options.className,
          idHex,
        );
        // A handler that set its own new alarm before throwing supersedes
        // the auto-retry — only schedule one if nothing is pending.
        if (stillPending === null) {
          const backoff = ALARM_RETRY_BASE_MS * 2 ** retryCount;
          await scheduleRetry(
            this.#options.kv,
            this.#options.className,
            idHex,
            now + backoff,
            retryCount + 1,
          );
        }
      }
    } finally {
      if (lease !== undefined) await releaseLease(this.#options.kv, lease);
    }
  }
}

export function createDurableObjectNamespace<
```

- [ ] **Step 8: Modify `durable-object.ts` — add the retry constants**

Find:

```ts
interface Instance<T> {
  readonly object: T;
  readonly state: DenoDurableObjectState;
  chain: Promise<unknown>;
}
```

Replace with:

```ts
interface Instance<T> {
  readonly object: T;
  readonly state: DenoDurableObjectState;
  chain: Promise<unknown>;
}

const ALARM_RETRY_BASE_MS = 2_000;
const ALARM_RETRY_MAX = 6;
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test --project @dwk/deno-host durable-object-alarms`
Expected: PASS (5 tests).

- [ ] **Step 10: Re-run the whole package's suite**

Run: `pnpm test --project @dwk/deno-host`
Expected: PASS — all prior tasks' tests (d1, sql-storage, lease, alarms,
durable-object, durable-object-alarms) still pass; the storage type change
in Step 5 must not have broken Task 4's tests (they only read `ctx.storage
.sql`, never `ctx.storage` structurally, so this should be a non-issue —
confirm it explicitly here).

- [ ] **Step 11: Update the `index.ts` export list**

Find:

```ts
export {
  createDurableObjectNamespace,
  DurableObject,
  DenoDurableObjectId,
  DenoDurableObjectState,
  type DurableObjectClass,
  type DurableObjectNamespaceOptions,
  type AlarmInvocationInfo,
} from "./durable-object.js";
```

Replace with:

```ts
export {
  createDurableObjectNamespace,
  DurableObject,
  DenoDurableObjectId,
  DenoDurableObjectState,
  type DurableObjectClass,
  type DurableObjectNamespaceOptions,
  type DenoDurableObjectStorage,
  type AlarmInvocationInfo,
} from "./durable-object.js";
```

- [ ] **Step 12: Typecheck and commit**

Run: `pnpm --filter @dwk/deno-host typecheck`
Expected: no errors.

```bash
git add packages/deno-host/src/durable-object.ts packages/deno-host/src/durable-object-alarms.test.ts packages/deno-host/src/index.ts
git commit -m "feat(deno-host): add pollAlarms — alarm firing, retry, and supersede (#398)"
```

---

## Task 6: Package bookkeeping — README, spec status, changeset

**Files:**
- Modify: `packages/deno-host/README.md`
- Modify: `spec/packages/deno-host.md`
- Modify: `packages/deno-host/package.json` (`"Ships a DO?"` row is in the
  spec, not here — no package.json change is actually needed; this file
  entry exists only to confirm that was checked, not to leave a stray
  "TBD")
- Create: `.changeset/deno-host-actor-alarm.md`
- Modify: `CLAUDE.md`

**Interfaces:** None — this task changes no code, only status text and the
release record.

- [ ] **Step 1: Run the full local CI gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. This is the same sequence `.github/workflows/ci.yml`
runs — matching it locally before the PR is what CLAUDE.md requires.

- [ ] **Step 2: Update `spec/packages/deno-host.md`'s status blockquote**

Find:

```markdown
> **Status: exploratory/gated.** Implements the SQL gap (issue #397) of the
> demand-gated `@dwk/deno-host` plan (#396;
> [deno-deploy-design.md](../deno-deploy-design.md) §3.1). The single-writer
> actor + alarm emulation (#398, gate overridden on demonstrated demand —
> design finalized, see
> [below](#design-single-writer-actor--alarm-emulation-issue-398), **not yet
> implemented**), the KV-backed queue (#399), and the `R2Bucket`
> object-storage adapter (#400) are **not** implemented, so no endpoint
> package can mount on this host yet — per
> [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate) even
> Tier 1 ([host-contract.md §9](../host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance))
> needs the queue gap closed first. #399/#400 stay demand-gated.
```

Replace with:

```markdown
> **Status: exploratory/gated.** Implements the SQL gap (issue #397) and the
> single-writer actor + alarm emulation (issue #398, gate overridden on
> demonstrated demand — see
> [below](#design-single-writer-actor--alarm-emulation-issue-398)) of the
> demand-gated `@dwk/deno-host` plan (#396;
> [deno-deploy-design.md](../deno-deploy-design.md) §3.1, §3.2). The
> KV-backed queue (#399) and the `R2Bucket` object-storage adapter (#400)
> are **not** implemented, so no endpoint package can mount on this host
> yet — per
> [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate) even
> Tier 1 ([host-contract.md §9](../host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance))
> needs the queue gap closed first. #399/#400 stay demand-gated.
```

- [ ] **Step 3: Update the "Design: single-writer actor..." section's own status line and the `"Ships a DO?"` table row**

Find:

```markdown
| **Ships a DO?** | no (will emulate one — #398, not yet implemented) |
```

Replace with:

```markdown
| **Ships a DO?** | no (emulates one in-process via `createDurableObjectNamespace` — #398) |
```

Find:

```markdown
> **Status: design finalized (this section), not yet implemented.** Approved
> 2026-07-23 via the brainstorming process on a demonstrated demand signal
> that overrode the demand gate for this increment only — #399 (queues) and
> #400 (object storage) stay gated. See
> [issue #398](https://github.com/davidwkeith/workers/issues/398) and
> [deno-deploy-design.md §3.2](../deno-deploy-design.md#32-single-writer-actor-durable-objects-host-contract-33).
```

Replace with:

```markdown
> **Status: implemented.** Approved 2026-07-23 via the brainstorming
> process on a demonstrated demand signal that overrode the demand gate for
> this increment only — #399 (queues) and #400 (object storage) stay
> gated. See [issue #398](https://github.com/davidwkeith/workers/issues/398)
> and
> [deno-deploy-design.md §3.2](../deno-deploy-design.md#32-single-writer-actor-durable-objects-host-contract-33).
```

- [ ] **Step 4: Update the "Non-goals" list**

Find:

```markdown
- Single-writer actor + alarm emulation via a Deno KV lease — #398. Design
  finalized above; implementation not yet started.
- Durable at-least-once queue emulation on Deno KV — #399.
- `R2Bucket`-shaped adapter over an S3-compatible store — #400.
- Any commitment to proceed with #399/#400: the decision gate in
  [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate)
  still holds for the remainder of the plan; only #398 was greenlit, on a
  demonstrated demand signal specific to it.
```

Replace with:

```markdown
- Durable at-least-once queue emulation on Deno KV — #399.
- `R2Bucket`-shaped adapter over an S3-compatible store — #400.
- Any commitment to proceed with #399/#400: the decision gate in
  [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate)
  still holds for the remainder of the plan; only #398 was greenlit, on a
  demonstrated demand signal specific to it.
```

(The list header "## Non-goals (tracked separately)" stays as-is — #399/#400
are still genuinely out of scope.)

- [ ] **Step 5: Write `packages/deno-host/README.md`'s new section**

Add after the existing "## Consistency (host-contract §4)"-equivalent
content (i.e. right before "## What still needs live verification"), a new
section summarizing the implemented actor/alarm surface:

```markdown
## `createDurableObjectNamespace(ctor, options)` — host-contract §3.3

Single-writer actor + alarm emulation over a per-id Deno KV lease (issue
#398). `options` takes an injected `DenoKvLike` (a structural subset of
`Deno.Kv` — the package never constructs a connection itself), a
`getStorageClient(idHex)` factory returning the id's libSQL embedded-replica
client, and the composed `Env`.

```ts
import { openKv } from "node:process"; // illustrative — use Deno.openKv() on Deno Deploy
import Database from "libsql";
import {
  createDurableObjectNamespace,
  DurableObject,
} from "@dwk/deno-host";

class PodObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    /* ... uses this.ctx.storage.sql / transactionSync / setAlarm ... */
  }
  async alarm(): Promise<void> {
    /* retry logic, same shape as the Cloudflare original */
  }
}

const POD = createDurableObjectNamespace(PodObject, {
  kv: await Deno.openKv(),
  className: "Pod",
  env,
  getStorageClient: (idHex) => {
    const db = new Database(`/tmp/pod-${idHex}.db`, {
      syncUrl: Deno.env.get("TURSO_DATABASE_URL")!,
      authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
    });
    db.sync();
    return db;
  },
});

// Wire to Deno.cron() — the package never starts its own timer.
Deno.cron("pod alarms", "* * * * *", () => POD.pollAlarms());
```

Per-id single-writer is enforced by a KV atomic-CAS lease, acquired once per
`fetch()`/`alarm()` delivery and released after (no renewal loop) — a
contended lease throws `LeaseContendedError` after a bounded retry, which
the composing app maps to a 503. Alarms are indexed directly in KV (not
inside the per-id SQLite file) so `pollAlarms()` can find due entries with
one range scan. WebSockets (`ctx.acceptWebSocket`/`getWebSockets`) are an
in-memory per-instance socket set, ported from `@dwk/cf-shims` — see
[`spec/packages/deno-host.md`](../../spec/packages/deno-host.md) for the
documented cross-process limitation on live sockets.
```

Also update the top status blockquote in the README to match Step 2's spec
change (same replacement text, adapted to the README's existing wording
around lines 10–17).

- [ ] **Step 6: Update `CLAUDE.md`'s `@dwk/deno-host` description**

Find (in the "What this is" section's `@dwk/deno-host` paragraph):

```markdown
`@dwk/deno-host` is the newest — the first increment (#397) of the otherwise
still demand-gated Deno Deploy host plan (#396): runtime-agnostic,
dependency-free shims presenting an external libSQL/Turso database behind
the host-contract `D1Database` (async remote client) and
`SqlStorage`/`transactionSync` (synchronous embedded replica client)
surfaces, via injected structural client seams; the actor/alarm, queue, and
object-storage gaps (#398–#400) are not implemented and remain gated.
```

Replace with:

```markdown
`@dwk/deno-host` is the newest — two increments of the otherwise still
demand-gated Deno Deploy host plan (#396): runtime-agnostic,
dependency-free shims presenting an external libSQL/Turso database behind
the host-contract `D1Database` (async remote client) and
`SqlStorage`/`transactionSync` (synchronous embedded replica client)
surfaces (#397), and `createDurableObjectNamespace`, a single-writer actor +
alarm emulation over a per-id Deno KV atomic-CAS lease, with an in-memory
WebSocket stub (#398, gate overridden on demonstrated demand). The queue and
object-storage gaps (#399, #400) are not implemented and remain gated.
```

- [ ] **Step 7: Add the changeset**

```bash
cat > .changeset/deno-host-actor-alarm.md << 'EOF'
---
"@dwk/deno-host": minor
---

`createDurableObjectNamespace(ctor, options)`: single-writer actor + alarm
emulation for Deno Deploy (issue #398, host-contract §3.3), built on a
per-request Deno KV atomic-CAS lease (bounded-retry contention, throwing
`LeaseContendedError`) rather than a renewed session lease. Alarms are
indexed directly in KV (not the per-id SQLite file) so `pollAlarms()` — an
exported tick method the composing app wires to its own periodic trigger
(`Deno.cron()` on Deno Deploy) — can find due entries with one range scan;
a throwing handler is retried with exponential backoff (matching
`@dwk/cf-shims`' schedule) unless it sets its own new alarm first, which
supersedes the retry. `ctx.acceptWebSocket`/`getWebSockets` is an in-memory
per-instance socket set ported from `@dwk/cf-shims`, with a documented
cross-process limitation on live sockets (spec/packages/deno-host.md).
Overrides the demand gate in `deno-deploy-design.md` §6 for this increment
only — #399 (queues) and #400 (object storage) stay gated.
EOF
```

- [ ] **Step 8: Confirm no catalog/conformance changes are needed**

`@dwk/deno-host` already has a `catalog.json` `"libraries"`-style exclusion
entry ("not mountable") and a `conformance/status.json` entry with
`"suites": []`/`"integration": {"status": "pending"}` from #397 — both
still accurate (the package still can't mount an endpoint package standalone
until #399/#400 close the queue/object-storage gaps too, per
`deno-deploy-design.md` §6). No changes to either file. If the PR template's
checklist has a "Updated catalog.json/conformance/status.json" item, check
it with a one-line reason ("not applicable — @dwk/deno-host still isn't
mountable; #399/#400 remain the blocker, unchanged by #398") rather than
leaving it silently unchecked.

- [ ] **Step 9: Re-run the full local CI gate one more time**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`
Expected: all green, including the doc-only changes (format:check covers
Markdown too).

- [ ] **Step 10: Commit**

```bash
git add packages/deno-host/README.md spec/packages/deno-host.md CLAUDE.md .changeset/deno-host-actor-alarm.md
git commit -m "docs(deno-host): mark #398 implemented, update README/CLAUDE.md, add changeset"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** every subsection of `spec/packages/deno-host.md`'s
  "Design: single-writer actor + alarm emulation (issue #398)" maps to a
  task — `DenoKvLike` → Task 1; lease → Task 2; alarms → Task 3;
  `createDurableObjectNamespace`/id hashing/dispatch → Task 4; WebSocket
  support → Task 4 (folded in, since it shares `DenoDurableObjectState`);
  `pollAlarms`/retry/supersede → Task 5; consistency table and testing plan
  → covered by the test suites across Tasks 2–5; live-verification
  addendum items (real `Deno.Kv` CAS/TTL/ordering, cron tick granularity) —
  **no task closes these**, intentionally: they require a live Deno Deploy
  deployment this plan does not provision, same posture #397 already
  established for its own three live-verification items. Task 6 does not
  claim them closed.
- **Deviation from the design doc, called out explicitly:** `pollAlarms` is
  a namespace **method**, not a free function taking `namespace` as its
  first argument as the design doc's illustrative code sketch showed (see
  Global Constraints). Functionally equivalent; noted so a reviewer
  comparing this plan against the spec doc doesn't read it as a missed
  requirement.
- **Type consistency check performed:** `DenoDurableObjectStorage` (Task 5)
  is used as `DenoDurableObjectState`'s `storage` field type from Task 5
  onward — Task 4's own tests never reference `ctx.storage` beyond `.sql`,
  so the type widening in Task 5 doesn't invalidate Task 4's already-passing
  tests structurally, but Task 5 Step 10 explicitly re-runs the full suite
  to confirm. `retryCount` threading (`AlarmRecord.retryCount` in
  `alarms.ts` → `DueAlarmEntry.retryCount` → `pollAlarms`'s loop →
  `#fireAlarm(idHex, retryCount, now)` → `AlarmInvocationInfo.retryCount`
  passed to the handler → `scheduleRetry(..., retryCount + 1)` on failure)
  is consistent end-to-end — this was a real bug caught and fixed during
  planning (an earlier draft always fired with `retryCount: 0`, losing
  `isRetry` semantics across polls); the final code in Task 3/Task 5 above
  is the corrected version.
