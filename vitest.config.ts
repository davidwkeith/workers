import { defineConfig } from "vitest/config";

// Root config aggregates every package's project config so `pnpm test` runs the
// full suite: pure libs under the Node environment, runtime-bound packages under
// workerd via @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
    coverage: {
      // Istanbul (babel-instrumented), not v8: the v8 provider imports
      // `node:inspector/promises`, which the workerd pool does not provide, so
      // it cannot instrument the runtime-bound packages. Istanbul works under
      // both the Node and workerd environments, giving one number for the repo.
      provider: "istanbul",
      reporter: ["text-summary", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/test-harness.ts",
        "**/index.ts",
        "**/vitest.config.ts",
      ],
      // Non-regression floor: set safely below the suite's current coverage so a
      // meaningful drop fails CI without flaking on incidental churn. Ratchet up
      // as the P1/P2 gaps close.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 78,
        lines: 80,
      },
    },
  },
});
