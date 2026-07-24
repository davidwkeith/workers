import { describe, it, expect } from "vitest";
import { createCentralHealthMounts } from "./central-health.js";
import type { FetchHandler, Mount } from "./config.js";

function call(mount: Mount, path: string): Promise<Response> {
  return (mount.handler as unknown as FetchHandler)(
    new Request(`http://localhost${path}`),
    {} as never,
    {} as ExecutionContext,
  );
}

function find(mounts: readonly Mount[], name: string): Mount {
  const mount = mounts.find((m) => m.name === name);
  if (mount === undefined) throw new Error(`no mount named ${name}`);
  return mount;
}

describe("createCentralHealthMounts", () => {
  it("liveness always reports 200 without touching any store", async () => {
    const mounts = createCentralHealthMounts({
      probeTargets: {
        kv: {
          set: () => Promise.reject(new Error("must not be called")),
        } as never,
      },
    });
    const live = find(mounts, "@dwk/server:health-live");
    expect(live.reservedPaths).toEqual(["/healthz"]);
    const res = await call(live, "/healthz");
    expect(res.status).toBe(200);
  });

  it("readiness reports 200 when the probe succeeds", async () => {
    let calls = 0;
    const mounts = createCentralHealthMounts({
      probeTargets: {
        kv: {
          set: async () => {
            calls++;
            return { versionstamp: "x" };
          },
          get: async () => ({ key: [], value: true, versionstamp: "x" }),
          delete: async () => {},
        } as never,
      },
    });
    const ready = find(mounts, "@dwk/server:health-ready");
    expect(ready.reservedPaths).toEqual(["/readyz"]);
    const res = await call(ready, "/readyz");
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("readiness reports 503 with failure detail when a store probe fails, and recovers once it succeeds again", async () => {
    let broken = true;
    let now = 0;
    const mounts = createCentralHealthMounts({
      now: () => now,
      cacheMs: 1000,
      probeTargets: {
        kv: {
          set: async () => {
            if (broken) throw new Error("kv unreachable");
            return { versionstamp: "x" };
          },
          get: async () => ({ key: [], value: true, versionstamp: "x" }),
          delete: async () => {},
        } as never,
      },
    });
    const ready = find(mounts, "@dwk/server:health-ready");

    const failing = await call(ready, "/readyz");
    expect(failing.status).toBe(503);
    const body = (await failing.json()) as {
      ok: boolean;
      failures: { store: string; error: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.failures[0]?.store).toBe("coordination-kv");
    expect(body.failures[0]?.error).toContain("kv unreachable");

    broken = false;
    now = 5000; // past the cache TTL — forces a re-probe
    const recovered = await call(ready, "/readyz");
    expect(recovered.status).toBe(200);
  });

  it("readiness caches the probe result within cacheMs", async () => {
    let calls = 0;
    let now = 0;
    const mounts = createCentralHealthMounts({
      now: () => now,
      cacheMs: 1000,
      probeTargets: {
        kv: {
          set: async () => {
            calls++;
            return { versionstamp: "x" };
          },
          get: async () => ({ key: [], value: true, versionstamp: "x" }),
          delete: async () => {},
        } as never,
      },
    });
    const ready = find(mounts, "@dwk/server:health-ready");

    await call(ready, "/readyz");
    now = 500; // within the cache window
    await call(ready, "/readyz");
    expect(calls).toBe(1);

    now = 1500; // past the cache window
    await call(ready, "/readyz");
    expect(calls).toBe(2);
  });

  it("uses custom paths when configured", () => {
    const mounts = createCentralHealthMounts({
      probeTargets: { kv: {} as never },
      livenessPath: "/live",
      readinessPath: "/ready",
    });
    expect(find(mounts, "@dwk/server:health-live").reservedPaths).toEqual([
      "/live",
    ]);
    expect(find(mounts, "@dwk/server:health-ready").reservedPaths).toEqual([
      "/ready",
    ]);
  });
});
