import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-05",
        d1Databases: ["AUTH_DB"],
        bindings: {
          TOKEN_SIGNING_KEY: "test-signing-key-not-for-production",
        },
      },
    }),
  ],
  test: {
    name: "@dwk/indieauth",
  },
});
