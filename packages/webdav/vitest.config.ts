import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `@dwk/webdav` fronts the per-pod `SolidPodObject` Durable Object, so it runs
// under workerd (the runtime/binding-bound test group). The lock + credential
// stores and the verb router are exercised against a real SQLite-backed DO
// (`WebdavTestObject`) so the authoritative DO-SQLite state (spec §2) is tested
// at full fidelity rather than against an in-memory fake.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        durableObjects: {
          WEBDAV_DO: { className: "WebdavTestObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    name: "@dwk/webdav",
  },
});
