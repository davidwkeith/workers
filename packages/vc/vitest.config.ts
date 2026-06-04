import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        d1Databases: ["VC_STATUS_DB"],
        bindings: {
          // Replaced per-test with a real generated key; this is only a default.
          VC_SIGNING_KEY: "{}",
        },
      },
    }),
  ],
  test: {
    name: "@dwk/vc",
  },
});
