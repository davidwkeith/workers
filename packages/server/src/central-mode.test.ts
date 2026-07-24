import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  assertNoLocalStores,
  assertModeMarker,
  probeCentralStores,
  LocalStoreConflictError,
  ModeMarkerConflictError,
  StartupProbeError,
} from "./central-mode.js";
import { assembleCentralBindings } from "./central-bindings.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeLibsqlClient,
  FakeS3Client,
} from "./central-test-harness.js";

const tempDirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-central-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("assertNoLocalStores", () => {
  it("passes for a fresh or central-only dataDir", () => {
    expect(() => assertNoLocalStores(dataDir())).not.toThrow();
  });

  it.each(["d1", "r2", "do"])(
    "refuses a dataDir still holding local-mode %s/",
    (sub) => {
      const dir = dataDir();
      mkdirSync(join(dir, sub));
      expect(() => assertNoLocalStores(dir)).toThrow(LocalStoreConflictError);
    },
  );

  it("reports every offending subdirectory in one error", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "d1"));
    mkdirSync(join(dir, "r2"));
    try {
      assertNoLocalStores(dir);
      expect.fail("expected LocalStoreConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalStoreConflictError);
      expect((err as LocalStoreConflictError).found).toEqual(["d1", "r2"]);
    }
  });
});

describe("assertModeMarker", () => {
  it("writes the marker when absent, then validates it on a later call", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    await expect(assertModeMarker(kv)).resolves.toBeUndefined();
    const marker = await kv.get<string>(["dwk_meta", "mode"]);
    expect(marker.value).toBe("central");
    await expect(assertModeMarker(kv)).resolves.toBeUndefined();
  });

  it("throws when the marker records a different mode", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    await kv.set(["dwk_meta", "mode"], "local");
    await expect(assertModeMarker(kv)).rejects.toThrow(ModeMarkerConflictError);
  });
});

describe("probeCentralStores", () => {
  it("passes when every configured store round-trips", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    const env = assembleCentralBindings({
      d1: { AUTH_DB: createFakeLibsqlClient() },
      r2: {
        MEDIA: {
          client: new FakeS3Client(),
          endpoint: "https://s3.example.com/b",
        },
      },
    });
    await expect(
      probeCentralStores({
        kv,
        d1: { AUTH_DB: env.AUTH_DB as D1Database },
        objectStore: env.MEDIA as R2Bucket,
      }),
    ).resolves.toBeUndefined();
  });

  it("collects failures from every unreachable store, not just the first", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    const brokenD1 = {
      prepare: () => {
        throw new Error("connection refused");
      },
    } as unknown as D1Database;
    const brokenBucket = {
      put: async () => {
        throw new Error("no route to host");
      },
    } as unknown as R2Bucket;

    try {
      await probeCentralStores({
        kv,
        d1: { AUTH_DB: brokenD1 },
        objectStore: brokenBucket,
      });
      expect.fail("expected StartupProbeError");
    } catch (err) {
      expect(err).toBeInstanceOf(StartupProbeError);
      const failures = (err as StartupProbeError).failures;
      expect(failures.map((f) => f.store).sort()).toEqual([
        "d1:AUTH_DB",
        "object-store",
      ]);
    }
  });

  it("fails when the coordination KV is unreachable", async () => {
    const brokenKv = {
      get: async () => {
        throw new Error("kv unreachable");
      },
    } as never;
    await expect(probeCentralStores({ kv: brokenKv })).rejects.toThrow(
      StartupProbeError,
    );
  });
});
