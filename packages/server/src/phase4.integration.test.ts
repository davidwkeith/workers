/**
 * Phase 4 end-to-end: a real Durable-Object-backed package runs through the host
 * on the emulated DO.
 *
 * `@dwk/webauthn` is a per-relying-party Durable Object: its challenge state and
 * credential records live in DO-SQLite. This mounts it through `createServer`
 * with a {@link createDurableObjectNamespace} binding and drives the registration
 * ceremony's first leg — proving the full path host → `env.WEBAUTHN.idFromName`
 * → in-process DO instance → `state.storage.sql` works unchanged on Node (the
 * `cloudflare:workers` import is redirected to the shim by the vitest alias; in
 * production the `bin`'s loader hook does the same).
 *
 * `solid-pod` (LDP/WAC/patch over the same DO machinery, plus WebSocket
 * notifications) is the larger bring-up and is tracked as the remaining Phase 4
 * work.
 *
 * @see spec/self-hosting.md §7.4
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebAuthn, WebAuthnObject } from "@dwk/webauthn";

import { createServer } from "./server.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-phase4-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("Phase 4 — webauthn on the emulated Durable Object", () => {
  it("mints registration challenges through the per-RP DO", async () => {
    const dir = dataDir();
    const env: Record<string, unknown> = {};
    // The per-RP Durable Object namespace, backed by node:sqlite under dataDir.
    env.WEBAUTHN = createDurableObjectNamespace(WebAuthnObject, {
      dataDir: dir,
      env,
      className: "webauthn",
    });

    const handler = createWebAuthn({
      rpId: "example.com",
      rpName: "Example",
      origin: "https://example.com",
    });

    const server = createServer({
      baseUrl: "https://example.com",
      dataDir: dir,
      env,
      mounts: [
        {
          name: "@dwk/webauthn",
          handler: handler as unknown as FetchHandler,
          reservedPaths: ["/register", "/authenticate"],
          requires: ["WEBAUTHN"],
        },
      ],
    });
    const { port } = await server.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    try {
      const opts = async (path: string, user: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user }),
        });
        return res;
      };

      // Registration options: the DO mints a challenge and persists it in
      // DO-SQLite, then returns the ceremony options.
      const r1 = await opts("/register/options", { name: "alice" });
      expect(r1.status).toBe(200);
      const body1 = (await r1.json()) as {
        challenge: string;
        rp: { id: string };
      };
      expect(body1.rp.id).toBe("example.com");
      expect(body1.challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url

      // A second ceremony on the same RP id reuses the same DO instance and
      // mints a fresh, independent challenge.
      const r2 = await opts("/register/options", { name: "bob" });
      const body2 = (await r2.json()) as { challenge: string };
      expect(body2.challenge).not.toBe(body1.challenge);

      // The authentication ceremony's options leg also runs through the DO.
      const r3 = await fetch(`${base}/authenticate/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(r3.status).toBe(200);
      expect((await r3.json()) as { challenge: string }).toHaveProperty(
        "challenge",
      );
    } finally {
      await server.close();
    }
  });
});
