import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebfinger } from "@dwk/webfinger";
import { createServer, createCentralServer, type DwkServer } from "./server.js";
import { WaitUntilTracker } from "./context.js";
import { MissingBindingError } from "./config.js";
import type { FetchHandler, Mount } from "./config.js";
import { StartupProbeError } from "./central-mode.js";
import { LibsqlKv } from "./libsql-kv.js";
import { createFakeLibsqlClient } from "./central-test-harness.js";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "dwk-srv-"));
}

const webfingerMount: Mount = {
  name: "@dwk/webfinger",
  handler: createWebfinger({
    resources: {
      "acct:alice@example.com": {
        subject: "acct:alice@example.com",
        links: [
          {
            rel: "http://webfinger.net/rel/profile-page",
            href: "https://example.com/alice",
          },
        ],
      },
    },
  }) as unknown as FetchHandler,
  reservedPaths: ["/.well-known/webfinger"],
};

let server: DwkServer | null = null;
let base = "";

async function start(
  config: Parameters<typeof createServer>[0],
): Promise<void> {
  server = createServer(config);
  const { port } = await server.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("createServer (end-to-end)", () => {
  it("mounts a real endpoint package and serves it through the host", async () => {
    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      mounts: [webfingerMount],
      env: {},
    });
    const res = await fetch(
      `${base}/.well-known/webfinger?resource=acct:alice@example.com`,
    );
    expect(res.status).toBe(200);
    const jrd = (await res.json()) as { subject: string };
    expect(jrd.subject).toBe("acct:alice@example.com");

    const miss = await fetch(
      `${base}/.well-known/webfinger?resource=acct:nobody@example.com`,
    );
    expect(miss.status).toBe(404);
  });

  it("gives reserved protocol paths precedence over static files", async () => {
    const publicDir = dataDir();
    mkdirSync(join(publicDir, ".well-known"), { recursive: true });
    // A static file that must NOT shadow the WebFinger endpoint.
    writeFileSync(join(publicDir, ".well-known", "webfinger"), "STATIC");
    writeFileSync(join(publicDir, "index.html"), "<h1>home</h1>");

    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      publicDir,
      mounts: [webfingerMount],
      env: {},
    });

    const endpoint = await fetch(
      `${base}/.well-known/webfinger?resource=acct:alice@example.com`,
    );
    expect(endpoint.headers.get("content-type")).toContain("jrd");
    expect(await endpoint.text()).not.toBe("STATIC");

    const staticFile = await fetch(`${base}/index.html`);
    expect(await staticFile.text()).toContain("home");
  });

  it("sets baseline security headers and refuses to serve a dotfile", async () => {
    const publicDir = dataDir();
    writeFileSync(join(publicDir, ".env"), "SECRET=nope");
    writeFileSync(join(publicDir, "index.html"), "<h1>home</h1>");

    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      publicDir,
      mounts: [webfingerMount],
      env: {},
    });

    const res = await fetch(`${base}/index.html`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
    // No CSP: publicDir can serve an arbitrary self-hosted site.
    expect(res.headers.get("content-security-policy")).toBeNull();
    // Relaxed from helmet's "same-origin" default: a browser on another
    // origin must still be able to fetch this host's WebFinger/ActivityPub/
    // IndieAuth discovery documents directly.
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );

    const dotfile = await fetch(`${base}/.env`);
    expect(dotfile.status).not.toBe(200);
  });

  it("runs the configurable fallback for unmatched routes (default 404)", async () => {
    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      mounts: [webfingerMount],
      env: {},
    });
    const res = await fetch(`${base}/nothing-here`);
    expect(res.status).toBe(404);
  });

  it("passes the assembled env and tracks waitUntil work", async () => {
    let resolved = false;
    const tracker = new WaitUntilTracker();
    const mount: Mount = {
      name: "synthetic",
      reservedPaths: ["/echo"],
      requires: ["SECRET"],
      handler: (async (_request, env, ctx) => {
        const e = env as unknown as { SECRET: string };
        ctx.waitUntil(
          new Promise<void>((r) =>
            setTimeout(() => {
              resolved = true;
              r();
            }, 10),
          ),
        );
        return new Response(e.SECRET);
      }) as FetchHandler,
    };
    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      mounts: [mount],
      env: { SECRET: "shh" },
    });
    const res = await fetch(`${base}/echo`);
    expect(await res.text()).toBe("shh");
    // close() drains waitUntil work.
    await server?.close();
    server = null;
    expect(resolved).toBe(true);
    void tracker;
  });

  it("fails loud at startup when a required binding is missing", () => {
    expect(() =>
      createServer({
        baseUrl: "http://localhost",
        dataDir: dataDir(),
        mounts: [
          {
            name: "needs-db",
            handler: webfingerMount.handler,
            reservedPaths: ["/x"],
            requires: ["AUTH_DB"],
          },
        ],
        env: {},
      }),
    ).toThrow(MissingBindingError);
  });

  it("serves the SPA fallback for unmatched GETs when configured", async () => {
    const publicDir = dataDir();
    writeFileSync(join(publicDir, "index.html"), "<h1>spa</h1>");
    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      publicDir,
      spaFallback: true,
      mounts: [webfingerMount],
      env: {},
    });
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });

  it("returns 500 when a mounted handler throws", async () => {
    const mount: Mount = {
      name: "boom",
      reservedPaths: ["/boom"],
      handler: (async () => {
        throw new Error("handler boom");
      }) as FetchHandler,
    };
    await start({
      baseUrl: "http://localhost",
      dataDir: dataDir(),
      mounts: [mount],
      env: {},
    });
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
  });

  it("refuses an insecure non-localhost base URL outside dev mode", () => {
    expect(() =>
      createServer({
        baseUrl: "http://example.com",
        dataDir: dataDir(),
        mounts: [webfingerMount],
        env: {},
      }),
    ).toThrow();
  });
});

describe("createCentralServer", () => {
  it("runs the mode-marker + startup probes before serving, then works normally", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    server = await createCentralServer(
      {
        baseUrl: "http://localhost",
        dataDir: dataDir(),
        mounts: [webfingerMount],
        env: {},
        storage: { mode: "central", kv },
      },
      {},
    );
    const { port } = await server.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${port}`;

    const res = await fetch(
      `${base}/.well-known/webfinger?resource=acct:alice@example.com`,
    );
    expect(res.status).toBe(200);

    const marker = await kv.get<string>(["dwk_meta", "mode"]);
    expect(marker.value).toBe("central");
  });

  it("rejects before serving when a configured store is unreachable", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    const brokenD1 = {
      prepare: () => {
        throw new Error("connection refused");
      },
    } as never;

    await expect(
      createCentralServer(
        {
          baseUrl: "http://localhost",
          dataDir: dataDir(),
          mounts: [webfingerMount],
          env: {},
          storage: { mode: "central", kv },
        },
        { d1: { AUTH_DB: brokenD1 } },
      ),
    ).rejects.toThrow(StartupProbeError);
  });
});
