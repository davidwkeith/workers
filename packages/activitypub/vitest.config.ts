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
        // `createActivitypubMastodonApi` composes `@dwk/mastodon-api`'s
        // `createMastodonApi`, which requires the `AUTH_DB` D1 binding (its
        // auth/app/token store) at request time — needed here so
        // `mastodon-api.test.ts` can drive the composed handler end-to-end.
        d1Databases: ["AUTH_DB"],
      },
    }),
  ],
  test: {
    name: "@dwk/activitypub",
  },
});
