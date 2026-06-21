import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@dwk/log";
import {
  parseArgs,
  loadConfig,
  startServer,
  main,
  createShutdown,
} from "./cli.js";

const dirs: string[] = [];

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-cli-"));
  dirs.push(dir);
  return dir;
}

/** Write a config module and return its path. */
function configFile(source: string): string {
  const path = join(workdir(), "config.mjs");
  writeFileSync(path, source);
  return path;
}

/** A valid hermetic config: one inline mount, no @dwk packages, no lock. */
function pingConfig(): string {
  const dir = workdir();
  return `export default {
    baseUrl: "http://localhost",
    dataDir: ${JSON.stringify(dir)},
    env: {},
    lock: false,
    mounts: [
      {
        name: "ping",
        reservedPaths: ["/ping"],
        handler: async () => new Response("pong"),
      },
    ],
  };`;
}

interface Captured {
  logger: Logger;
  events: Array<{ event: string; fields?: Record<string, unknown> }>;
}

function capture(): Captured {
  const events: Captured["events"] = [];
  const logger = {
    debug() {},
    info(event: string, fields?: Record<string, unknown>) {
      events.push({ event, fields });
    },
    warn() {},
    error() {},
  } as unknown as Logger;
  return { logger, events };
}

function portFrom({ events }: Captured): number {
  const fields = events.find((e) => e.event === "cli.listening")?.fields;
  return (fields?.port as number | undefined) ?? 0;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("dwk-serve CLI", () => {
  describe("parseArgs", () => {
    it("reads the config path, --port and --host", () => {
      expect(
        parseArgs(["./c.js", "--port", "8080", "--host", "0.0.0.0"]),
      ).toEqual({ configPath: "./c.js", port: 8080, host: "0.0.0.0" });
      expect(parseArgs(["-p", "9", "-H", "::1", "cfg.js"])).toEqual({
        configPath: "cfg.js",
        port: 9,
        host: "::1",
      });
    });

    it("falls back to $DWK_CONFIG then ./dwk.config.js", () => {
      const prev = process.env.DWK_CONFIG;
      delete process.env.DWK_CONFIG;
      expect(parseArgs([]).configPath).toBe("./dwk.config.js");
      process.env.DWK_CONFIG = "/etc/dwk/x.js";
      expect(parseArgs([]).configPath).toBe("/etc/dwk/x.js");
      if (prev === undefined) delete process.env.DWK_CONFIG;
      else process.env.DWK_CONFIG = prev;
    });

    it("rejects an invalid --port rather than passing NaN to listen", () => {
      expect(() => parseArgs(["--port", "abc"])).toThrow(/invalid port/);
      expect(() => parseArgs(["--port", "70000"])).toThrow(/invalid port/);
      // A dangling flag with no value is ignored (falls back to the default).
      expect(parseArgs(["--port"]).port).toBeUndefined();
    });
  });

  describe("loadConfig", () => {
    it("resolves a default-exported HostConfig", async () => {
      const config = await loadConfig(configFile(pingConfig()));
      expect(config.baseUrl).toBe("http://localhost");
      expect(config.mounts).toHaveLength(1);
    });

    it("resolves a factory-function export", async () => {
      const dir = workdir();
      const path = configFile(
        `export default () => ({ baseUrl: "http://localhost", dataDir: ${JSON.stringify(dir)}, env: {}, lock: false, mounts: [] });`,
      );
      expect((await loadConfig(path)).baseUrl).toBe("http://localhost");
    });

    it("rejects a module with no config export", async () => {
      const path = configFile("export const nope = 1;");
      await expect(loadConfig(path)).rejects.toThrow(/default export/);
    });

    it("rejects an export that is not a HostConfig", async () => {
      const path = configFile("export default 42;");
      await expect(loadConfig(path)).rejects.toThrow(/valid HostConfig/);
    });
  });

  describe("startServer", () => {
    it("boots from a config, serves a mount, and logs the bound port", async () => {
      const config = await loadConfig(configFile(pingConfig()));
      const cap = capture();
      const { server, port } = await startServer(config, {
        port: 0,
        host: "127.0.0.1",
        logger: cap.logger,
        signals: false,
      });
      try {
        expect(port).toBeGreaterThan(0);
        expect(portFrom(cap)).toBe(port);
        const res = await fetch(`http://127.0.0.1:${port}/ping`);
        expect(await res.text()).toBe("pong");
      } finally {
        await server.close();
      }
    });
  });

  describe("main", () => {
    it("parses args, loads the config path, and starts listening", async () => {
      const path = configFile(pingConfig());
      const cap = capture();
      const server = await main({
        argv: [path, "--port", "0", "--host", "127.0.0.1"],
        logger: cap.logger,
        signals: false,
      });
      try {
        const port = portFrom(cap);
        expect(port).toBeGreaterThan(0);
        expect(
          await (await fetch(`http://127.0.0.1:${port}/ping`)).text(),
        ).toBe("pong");
      } finally {
        await server.close();
      }
    });

    it("registers SIGTERM/SIGINT handlers when signals are enabled", async () => {
      const path = configFile(pingConfig());
      const cap = capture();
      const before = {
        term: process.listeners("SIGTERM"),
        int: process.listeners("SIGINT"),
      };
      const server = await main({
        argv: [path, "--port", "0", "--host", "127.0.0.1"],
        logger: cap.logger,
        // default signals: true
      });
      try {
        // A fresh SIGTERM + SIGINT handler was installed.
        const added = (sig: "SIGTERM" | "SIGINT", prev: unknown[]) =>
          process.listeners(sig).filter((l) => !prev.includes(l));
        expect(added("SIGTERM", before.term)).toHaveLength(1);
        expect(added("SIGINT", before.int)).toHaveLength(1);
        // Remove only the handlers we added, so the test does not leak.
        for (const l of added("SIGTERM", before.term))
          process.removeListener("SIGTERM", l);
        for (const l of added("SIGINT", before.int))
          process.removeListener("SIGINT", l);
      } finally {
        await server.close();
      }
    });
  });

  describe("startServer", () => {
    it("reads the port from $PORT when no option is given", async () => {
      const config = await loadConfig(configFile(pingConfig()));
      const prev = process.env.PORT;
      process.env.PORT = "0"; // a free port
      try {
        const { server, port } = await startServer(config, {
          host: "127.0.0.1",
          signals: false,
        });
        expect(port).toBeGreaterThan(0);
        await server.close();
      } finally {
        if (prev === undefined) delete process.env.PORT;
        else process.env.PORT = prev;
      }
    });
  });

  describe("createShutdown", () => {
    it("closes the server and exits 0", async () => {
      const config = await loadConfig(configFile(pingConfig()));
      const { server } = await startServer(config, {
        port: 0,
        host: "127.0.0.1",
        signals: false,
      });
      const cap = capture();
      const code = await new Promise<number>((resolveCode) => {
        createShutdown(server, cap.logger, resolveCode)("SIGTERM");
      });
      expect(code).toBe(0);
      expect(cap.events.some((e) => e.event === "cli.shutdown")).toBe(true);
    });

    it("logs and exits 1 when close fails", async () => {
      const failing = {
        close: () => Promise.reject(new Error("lock stuck")),
      } as unknown as Parameters<typeof createShutdown>[0];
      const events: Array<{ event: string; fields?: Record<string, unknown> }> =
        [];
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error(event: string, fields?: Record<string, unknown>) {
          events.push({ event, fields });
        },
      } as unknown as Parameters<typeof createShutdown>[1];
      const code = await new Promise<number>((resolveCode) => {
        createShutdown(failing, logger, resolveCode)("SIGINT");
      });
      expect(code).toBe(1);
      expect(
        events.find((e) => e.event === "cli.shutdown_error")?.fields,
      ).toEqual({ error: "lock stuck" });
    });
  });
});
