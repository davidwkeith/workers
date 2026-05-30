import { defineConfig } from "vitest/config";

// Root config aggregates every package's project config so `pnpm test` runs the
// full suite: pure libs under the Node environment, runtime-bound packages under
// workerd via @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
