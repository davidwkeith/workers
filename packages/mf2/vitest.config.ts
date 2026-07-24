import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `HTMLRewriter` is a workerd global, so the extractor and sanitizer are
// exercised under the Workers test pool (no bindings needed).
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-05",
      },
    }),
  ],
  test: {
    name: "@dwk/mf2",
  },
});
