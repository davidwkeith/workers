/**
 * `dwk-serve` — the self-host CLI / `bin` ([spec §10](../../../spec/self-hosting.md)).
 *
 * The secondary, run-on-the-host-directly path (the Docker image is primary).
 * The host config is the **composition root** the deployer writes — a module
 * that builds the `Env` from binding shims and lists the mounts (see
 * `examples/`). Two entry shapes share one lifecycle ({@link startServer}):
 *
 *   - **`main`** (the `bin`): `dwk-serve ./config.js` registers the
 *     `cloudflare:workers` loader hook, then dynamically imports the config so
 *     Durable-Object packages resolve the shim.
 *   - **`startServer(config)`**: the esbuild bundle's baked-in entry, where the
 *     specifier is already aliased at build time, so no hook is needed.
 *
 * Both `createServer` + `listen`, log the listening URL, and (unless disabled)
 * wire SIGTERM/SIGINT graceful shutdown.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { noopLogger, type Logger } from "@dwk/log";
import { registerCloudflareWorkers } from "@dwk/cf-shims";
import { createServer, type DwkServer } from "./server.js";
import type { HostConfig } from "./config.js";
import { loadDwkEnv } from "./env.js";

/** A config module: a default (or named `config`) export — value or factory. */
type ConfigExport =
  HostConfig | (() => HostConfig | Promise<HostConfig>) | undefined;
interface ConfigModule {
  readonly default?: ConfigExport;
  readonly config?: ConfigExport;
}

/** Lifecycle options shared by {@link startServer} and {@link main}. */
export interface StartOptions {
  /** Port to bind; defaults to `$PORT` then `3000`. `0` picks a free port. */
  readonly port?: number;
  /** Host/interface to bind; defaults to `$HOST` then all interfaces. */
  readonly host?: string;
  /** Logger for CLI lifecycle events (listening/shutdown). Defaults to no-op. */
  readonly logger?: Logger;
  /** Install SIGTERM/SIGINT handlers (default true; pass false in tests). */
  readonly signals?: boolean;
}

/**
 * Load a host config module and resolve it to a {@link HostConfig}. The module
 * must default-export (or export `config`) a `HostConfig` or a function
 * returning one.
 */
export async function loadConfig(configPath: string): Promise<HostConfig> {
  const href = pathToFileURL(resolve(configPath)).href;
  const mod = (await import(href)) as ConfigModule;
  const exported = mod.default ?? mod.config;
  if (exported === undefined) {
    throw new Error(
      `${configPath}: expected a default export of a HostConfig (or a function returning one)`,
    );
  }
  const config = typeof exported === "function" ? await exported() : exported;
  if (
    config === null ||
    typeof config !== "object" ||
    typeof (config as HostConfig).baseUrl !== "string"
  ) {
    throw new Error(`${configPath}: did not produce a valid HostConfig`);
  }
  return config;
}

/**
 * Build the shutdown handler: log the signal, close the server, and exit `0`
 * (or `1` if close throws). `exit` is injectable for tests.
 */
export function createShutdown(
  server: DwkServer,
  logger: Logger,
  exit: (code: number) => void = process.exit,
): (signal: string) => void {
  return (signal: string): void => {
    logger.info("cli.shutdown", { signal });
    server
      .close()
      .then(() => exit(0))
      .catch((err: unknown) => {
        logger.error("cli.shutdown_error", {
          error: err instanceof Error ? err.message : String(err),
        });
        exit(1);
      });
  };
}

/** Parse a port value, rejecting anything that is not a valid TCP port. */
function parsePort(
  value: string | undefined,
  source: string,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source}: invalid port ${JSON.stringify(value)}`);
  }
  return port;
}

/** Install graceful-shutdown handlers that close `server` then exit. */
function installSignals(server: DwkServer, logger: Logger): void {
  const shutdown = createShutdown(server, logger);
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Start listening from an already-built {@link HostConfig}: `createServer`,
 * `listen`, log the bound URL, and (unless `signals: false`) wire graceful
 * shutdown. This is the esbuild bundle's entry point.
 */
export async function startServer(
  config: HostConfig,
  options: StartOptions = {},
): Promise<{ server: DwkServer; port: number }> {
  const logger = options.logger ?? noopLogger;
  const server = createServer(config);
  const port = options.port ?? parsePort(process.env.PORT, "$PORT") ?? 3000;
  const bound = await server.listen(port, options.host ?? process.env.HOST);
  logger.info("cli.listening", { baseUrl: server.origin, port: bound.port });
  if (options.signals !== false) installSignals(server, logger);
  return { server, port: bound.port };
}

/** Parsed `dwk-serve` arguments. */
export interface CliArgs {
  readonly configPath: string;
  readonly port?: number;
  readonly host?: string;
}

/**
 * Parse `dwk-serve [config] [--port N] [--host H]`. The config path defaults to
 * `$DWK_CONFIG` then `./dwk.config.js`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--port" || arg === "-p") {
      i += 1;
      port = parsePort(argv[i], arg);
    } else if (arg === "--host" || arg === "-H") {
      i += 1;
      host = argv[i];
    } else if (!arg.startsWith("-")) {
      configPath ??= arg;
    }
  }
  return {
    configPath: configPath ?? process.env.DWK_CONFIG ?? "./dwk.config.js",
    port,
    host,
  };
}

/** Options for {@link main}. */
export interface MainOptions extends StartOptions {
  readonly argv?: readonly string[];
}

/**
 * The `bin` entry: parse args, register the loader hook, load the config module,
 * and start the server. Returns the running server.
 */
export async function main(options: MainOptions = {}): Promise<DwkServer> {
  const { configPath, port, host } = parseArgs(
    options.argv ?? process.argv.slice(2),
  );
  // Redirect `cloudflare:workers` to the Node shim before the config — and the
  // Durable-Object packages it imports — are dynamically loaded.
  registerCloudflareWorkers();
  loadDwkEnv();
  const config = await loadConfig(configPath);
  const { server } = await startServer(config, {
    port: port ?? options.port,
    host: host ?? options.host,
    logger: options.logger,
    signals: options.signals,
  });
  return server;
}
