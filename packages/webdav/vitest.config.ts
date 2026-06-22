import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `@dwk/webdav` is destined to front the per-pod `SolidPodObject` Durable
// Object, so it runs under workerd (the runtime/binding-bound test group). The
// protocol-core modules shipped so far are pure (plain strings/bytes in, via
// WebCrypto), but the package is configured for its eventual home from the
// start to avoid a later node→workerd environment switch.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-01-01",
      },
    }),
  ],
  test: {
    name: "@dwk/webdav",
  },
});
