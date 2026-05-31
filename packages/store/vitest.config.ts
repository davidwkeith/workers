import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        durableObjects: {
          POD_DO: { className: "StoreTestObject", useSQLite: true },
        },
        r2Buckets: ["BLOBS"],
        d1Databases: ["GC_DB"],
      },
    }),
  ],
  test: {
    name: "@dwk/store",
  },
});
