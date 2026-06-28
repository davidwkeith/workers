import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CredentialStore } from "./credential-store.js";
import type { WebdavTestObject } from "./test-harness.js";

interface HarnessEnv {
  readonly WEBDAV_DO: DurableObjectNamespace<WebdavTestObject>;
}
const harness = env as unknown as HarnessEnv;

async function withSql<T>(fn: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const id = harness.WEBDAV_DO.idFromName(crypto.randomUUID());
  const stub = harness.WEBDAV_DO.get(id);
  return runInDurableObject(stub, (instance) => fn(instance.sql));
}

const WEBID = "https://me.example/#me";
// Cheap KDF so the suite stays fast; production uses the 600k default.
const ITER = 1000;

describe("CredentialStore", () => {
  it("mints, persists, and verifies an app password", async () => {
    await withSql(async (sql) => {
      const store = new CredentialStore(sql);
      const minted = await store.mint({
        webid: WEBID,
        label: "MacBook Finder",
        scope: { modes: ["read", "write"] },
        iterations: ITER,
      });
      const result = await store.verify(minted.username, minted.secret);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record.webid).toBe(WEBID);
      expect(result.record.scope.modes).toEqual(["read", "write"]);
    });
  });

  it("round-trips a path-prefixed read-only scope", async () => {
    await withSql(async (sql) => {
      const store = new CredentialStore(sql);
      const minted = await store.mint({
        webid: WEBID,
        label: "scoped",
        scope: { modes: ["read"], pathPrefix: "/photos/" },
        iterations: ITER,
      });
      const got = store.get(minted.username);
      expect(got?.scope).toEqual({ modes: ["read"], pathPrefix: "/photos/" });
    });
  });

  it("rejects a wrong secret and an unknown credential id as mismatch", async () => {
    await withSql(async (sql) => {
      const store = new CredentialStore(sql);
      const minted = await store.mint({
        webid: WEBID,
        label: "l",
        scope: { modes: ["read"] },
        iterations: ITER,
      });
      expect(await store.verify(minted.username, "wrong")).toEqual({
        ok: false,
        reason: "mismatch",
      });
      expect(await store.verify("wdav-ghost", "x")).toEqual({
        ok: false,
        reason: "mismatch",
      });
    });
  });

  it("lists by WebID and revokes", async () => {
    await withSql(async (sql) => {
      const store = new CredentialStore(sql);
      const a = await store.mint({
        webid: WEBID,
        label: "a",
        scope: { modes: ["read"] },
        iterations: ITER,
      });
      await store.mint({
        webid: WEBID,
        label: "b",
        scope: { modes: ["write"] },
        iterations: ITER,
      });
      expect(store.list(WEBID).map((r) => r.label)).toEqual(["a", "b"]);
      expect(store.revoke(a.username)).toBe(true);
      expect(store.revoke(a.username)).toBe(false);
      expect(store.list(WEBID).map((r) => r.label)).toEqual(["b"]);
    });
  });

  it("prunes an expired credential so it no longer verifies", async () => {
    await withSql(async (sql) => {
      const clock = { t: 1000 };
      const store = new CredentialStore(sql, {}, () => clock.t);
      const minted = await store.mint({
        webid: WEBID,
        label: "expiring",
        scope: { modes: ["read"] },
        iterations: ITER,
        expiresAt: 5000,
      });
      expect((await store.verify(minted.username, minted.secret)).ok).toBe(
        true,
      );
      clock.t = 6000;
      expect(await store.verify(minted.username, minted.secret)).toEqual({
        ok: false,
        reason: "mismatch",
      });
      expect(store.get(minted.username)).toBeNull();
    });
  });

  it("re-anchors the throttle window after a decay so fresh failures re-throttle", async () => {
    await withSql(async (sql) => {
      const clock = { t: 0 };
      const store = new CredentialStore(
        sql,
        { maxFailedAttempts: 3, windowMs: 1000 },
        () => clock.t,
      );
      const minted = await store.mint({
        webid: WEBID,
        label: "l",
        scope: { modes: ["read"] },
        iterations: ITER,
      });
      // Exhaust the window once.
      for (let i = 0; i < 3; i++) await store.verify(minted.username, "wrong");
      // Past the window: the next failure decays the old run and starts a fresh
      // one anchored on `now` (the bug set failed_since to the stale timestamp,
      // so the window never re-accumulated).
      clock.t = 2000;
      await store.verify(minted.username, "wrong");
      clock.t = 2100;
      await store.verify(minted.username, "wrong");
      clock.t = 2200;
      await store.verify(minted.username, "wrong");
      clock.t = 2300;
      expect(await store.verify(minted.username, minted.secret)).toEqual({
        ok: false,
        reason: "throttled",
      });
    });
  });

  it("throttles after repeated failures, then a success resets the counter", async () => {
    await withSql(async (sql) => {
      const clock = { t: 0 };
      const store = new CredentialStore(
        sql,
        { maxFailedAttempts: 3, windowMs: 1000 },
        () => clock.t,
      );
      const minted = await store.mint({
        webid: WEBID,
        label: "l",
        scope: { modes: ["read"] },
        iterations: ITER,
      });
      for (let i = 0; i < 3; i++) {
        expect(await store.verify(minted.username, "wrong")).toEqual({
          ok: false,
          reason: "mismatch",
        });
      }
      // Fourth attempt within the window is throttled — even with the right secret.
      expect(await store.verify(minted.username, minted.secret)).toEqual({
        ok: false,
        reason: "throttled",
      });
      // After the window elapses, the failure run decays and verification works.
      clock.t = 1500;
      const ok = await store.verify(minted.username, minted.secret);
      expect(ok.ok).toBe(true);
      // The counter reset: a fresh wrong attempt is a mismatch, not a throttle.
      expect(await store.verify(minted.username, "wrong")).toEqual({
        ok: false,
        reason: "mismatch",
      });
    });
  });
});
