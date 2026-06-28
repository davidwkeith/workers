import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { resolveLockPolicy } from "./config.js";
import { LockStore, parseTimeoutHeader, effectiveTimeout } from "./locks.js";
import type { WebdavTestObject } from "./test-harness.js";

interface HarnessEnv {
  readonly WEBDAV_DO: DurableObjectNamespace<WebdavTestObject>;
}
const harness = env as unknown as HarnessEnv;

/** Run `fn` against a fresh DO's real SQLite store. */
async function withSql<T>(fn: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const id = harness.WEBDAV_DO.idFromName(crypto.randomUUID());
  const stub = harness.WEBDAV_DO.get(id);
  return runInDurableObject(stub, (instance) => fn(instance.sql));
}

const policy = resolveLockPolicy({
  defaultTimeoutSeconds: 3600,
  maxTimeoutSeconds: 7200,
  maxInfinityDepth: 3,
});

describe("LockStore", () => {
  it("acquires an exclusive write lock with an opaquelocktoken URI", async () => {
    await withSql((sql) => {
      const clock = { t: 1000 };
      const locks = new LockStore(sql, policy, "/", () => clock.t);
      const result = locks.acquire({
        path: "/photos/a.jpg",
        depth: "0",
        ownerHref: "mailto:me@dwk.io",
        webid: "https://me.example/#me",
        timeoutSeconds: 600,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.lock.token).toMatch(/^opaquelocktoken:[0-9a-f-]{36}$/);
      expect(result.lock.expiresAt).toBe(1000 + 600 * 1000);
      expect(locks.locksOn("/photos/a.jpg")).toHaveLength(1);
    });
  });

  it("clamps a requested timeout to the policy ceiling", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      const result = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 1_000_000,
      });
      expect(result.ok && result.lock.expiresAt).toBe(
        policy.maxTimeoutSeconds * 1000,
      );
    });
  });

  it("rejects a second lock on an already-locked resource as a conflict", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      expect(
        locks.acquire({
          path: "/a",
          depth: "0",
          ownerHref: "",
          webid: "w",
          timeoutSeconds: 60,
        }).ok,
      ).toBe(true);
      const second = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w2",
        timeoutSeconds: 60,
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("conflict");
    });
  });

  it("blocks a mutation whose If: token does not match the holding lock", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      const taken = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;
      expect(locks.blockingLock("/a", undefined)?.token).toBe(taken.lock.token);
      expect(locks.blockingLock("/a", "opaquelocktoken:nope")).not.toBeNull();
      expect(locks.blockingLock("/a", taken.lock.token)).toBeNull();
    });
  });

  it("forbids a Depth: infinity lock on the storage root", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      const result = locks.acquire({
        path: "/",
        depth: "infinity",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("forbidden");
    });
  });

  it("forbids a Depth: infinity lock above the configured depth bound", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      // policy.maxInfinityDepth === 3 → /a/b/c/ (depth 3) ok, /a/b/c/d/ (4) not.
      expect(
        locks.acquire({
          path: "/a/b/c/",
          depth: "infinity",
          ownerHref: "",
          webid: "w",
          timeoutSeconds: 60,
        }).ok,
      ).toBe(true);
      const tooDeep = locks.acquire({
        path: "/a/b/c/d/",
        depth: "infinity",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(tooDeep.ok).toBe(false);
      if (!tooDeep.ok) expect(tooDeep.reason).toBe("forbidden");
    });
  });

  it("covers descendants with a Depth: infinity collection lock", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      const taken = locks.acquire({
        path: "/dir/",
        depth: "infinity",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;
      // A descendant write without the token is blocked by the covering lock.
      expect(locks.blockingLock("/dir/deep/file.txt", undefined)?.token).toBe(
        taken.lock.token,
      );
      // A sibling that merely shares a name prefix is not covered.
      expect(locks.blockingLock("/dirty.txt", undefined)).toBeNull();
    });
  });

  it("conflicts when taking an infinity lock over an already-locked descendant", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      expect(
        locks.acquire({
          path: "/dir/file",
          depth: "0",
          ownerHref: "",
          webid: "w",
          timeoutSeconds: 60,
        }).ok,
      ).toBe(true);
      const subtree = locks.acquire({
        path: "/dir/",
        depth: "infinity",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(subtree.ok).toBe(false);
    });
  });

  it("refreshes a live lock and rejects an unknown token", async () => {
    await withSql((sql) => {
      const clock = { t: 0 };
      const locks = new LockStore(sql, policy, "/", () => clock.t);
      const taken = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;
      clock.t = 30_000;
      const refreshed = locks.refresh(taken.lock.token, 120);
      expect(refreshed?.expiresAt).toBe(30_000 + 120 * 1000);
      expect(locks.refresh("opaquelocktoken:ghost", 60)).toBeNull();
    });
  });

  it("releases a lock and reports whether one existed", async () => {
    await withSql((sql) => {
      const locks = new LockStore(sql, policy, "/", () => 0);
      const taken = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(taken.ok).toBe(true);
      if (!taken.ok) return;
      expect(locks.unlock(taken.lock.token)).toBe(true);
      expect(locks.unlock(taken.lock.token)).toBe(false);
      expect(locks.locksOn("/a")).toHaveLength(0);
    });
  });

  it("prunes expired locks opportunistically so they stop blocking", async () => {
    await withSql((sql) => {
      const clock = { t: 0 };
      const locks = new LockStore(sql, policy, "/", () => clock.t);
      const taken = locks.acquire({
        path: "/a",
        depth: "0",
        ownerHref: "",
        webid: "w",
        timeoutSeconds: 60,
      });
      expect(taken.ok).toBe(true);
      // Advance the clock past expiry; the next op prunes it.
      clock.t = 61_000;
      expect(locks.blockingLock("/a", undefined)).toBeNull();
      expect(locks.locksOn("/a")).toHaveLength(0);
    });
  });
});

describe("Timeout header parsing", () => {
  it("reads the first Second-N value, ignoring Infinite", () => {
    expect(parseTimeoutHeader("Second-300")).toBe(300);
    expect(parseTimeoutHeader("Infinite, Second-600")).toBe(600);
    expect(parseTimeoutHeader("Infinite")).toBeNull();
    expect(parseTimeoutHeader(null)).toBeNull();
  });

  it("falls back to the policy default and clamps to the ceiling", () => {
    expect(effectiveTimeout(null, policy)).toBe(policy.defaultTimeoutSeconds);
    expect(effectiveTimeout(1_000_000, policy)).toBe(policy.maxTimeoutSeconds);
    expect(effectiveTimeout(120, policy)).toBe(120);
  });
});
