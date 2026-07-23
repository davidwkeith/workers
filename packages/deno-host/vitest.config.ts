import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@dwk/deno-host",
    environment: "node",
  },
});
