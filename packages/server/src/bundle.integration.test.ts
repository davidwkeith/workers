/**
 * The self-host bundle, end to end: `scripts/bundle.mjs` produces a single ESM
 * file (with `cloudflare:workers` aliased away), and that file — the Docker
 * image's payload — boots, serves a Durable-Object endpoint, and shuts down
 * cleanly on SIGTERM.
 *
 * Skipped unless the package is built (the bundle aliases `dist/`), which CI
 * does before the test step.
 *
 * @see spec/self-hosting.md §10
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distShim = join(pkgRoot, "dist", "cloudflare-workers.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe.skipIf(!existsSync(distShim))("self-host esbuild bundle", () => {
  it("bundles, boots, serves a DO endpoint, and shuts down", async () => {
    const work = mkdtempSync(join(tmpdir(), "dwk-bundle-"));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const out = join(work, "dwk-serve.mjs");
    const entry = join(pkgRoot, "examples", "serve.mjs");

    // Build the bundle through the published script.
    await execFileP("node", [
      join(pkgRoot, "scripts", "bundle.mjs"),
      entry,
      out,
    ]);
    const code = readFileSync(out, "utf8");
    expect(code).not.toContain("cloudflare:workers"); // aliased at build time
    expect(code.startsWith("#!/usr/bin/env node")).toBe(true);

    // Boot it as the image would.
    const child = spawn("node", [out], {
      env: {
        ...process.env,
        PORT: "0",
        DWK_BASE_URL: "http://127.0.0.1",
        DWK_DATA_DIR: join(work, "data"),
      },
    });
    cleanups.push(() => child.kill("SIGKILL"));

    const port = await new Promise<number>((resolvePort, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the bundle to listen")),
        20000,
      );
      child.stdout?.on("data", (d: Buffer) => {
        buffer += d.toString();
        const match = /"port":(\d+)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        reject(new Error(`bundle exited early (code ${String(exitCode)})`));
      });
    });

    // The WebAuthn Durable Object answers through the bundled, aliased shim.
    const res = await fetch(`http://127.0.0.1:${port}/register/options`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: { name: "alice" } }),
    });
    expect(res.status).toBe(200);

    // Graceful shutdown on SIGTERM exits 0.
    const exit = new Promise<number>((r) =>
      child.on("exit", (c) => r(c ?? -1)),
    );
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
  }, 40000);
});
