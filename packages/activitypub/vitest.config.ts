import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2026-07-05",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          ACTOR: { className: "ActivityPubObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    name: "@dwk/activitypub",
  },
});
