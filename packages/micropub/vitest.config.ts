import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
        d1Databases: ["MICROPUB_DB", "AUTH_DB"],
        r2Buckets: ["MEDIA"],
        bindings: {
          TOKEN_SIGNING_KEY: "test-signing-key-not-for-production",
        },
      },
    }),
  ],
  test: {
    name: "@dwk/micropub",
  },
});
