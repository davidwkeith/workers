import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Redirect the workerd `cloudflare:workers` module to the Node shim so
      // packages that `import { DurableObject }` from it run under vitest. In
      // production the host `bin` does this via @dwk/cf-shims'
      // `module.register` loader hook (cloudflare-workers-loader.ts).
      "cloudflare:workers": fileURLToPath(
        new URL("../cf-shims/src/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "@dwk/server",
    environment: "node",
  },
});
