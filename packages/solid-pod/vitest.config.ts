import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // N3.js depends on `readable-stream`, whose browser polyfill clashes with the
  // workers pool; map it to workerd's native Node stream (via nodejs_compat).
  resolve: {
    alias: {
      "readable-stream": "node:stream",
    },
  },
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        // `@dwk/rdf` (N3.js) pulls in `readable-stream`, which needs Node
        // built-ins; the pod runs the parser/serializer inside the DO.
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          POD: { className: "SolidPodObject", useSQLite: true },
        },
        r2Buckets: ["BLOBS"],
        d1Databases: ["GC_DB"],
      },
    }),
  ],
  test: {
    name: "@dwk/solid-pod",
  },
});
