/**
 * The host: an Express app that composes the endpoint packages, bridges Express
 * ⇄ Web fetch, serves static files, and drives the lifecycle.
 *
 * Routing precedence (§6.3) is load-bearing and mounted in this order:
 *   1. reserved protocol paths (`/.well-known/*` + each mount's configured
 *      paths) → dispatched to the fetch adapter, winning over any static file;
 *   2. `express.static(publicDir)` — the user's website;
 *   3. a configurable fallback (default 404, or an SPA `index.html` rewrite).
 *
 * @see spec/self-hosting.md §5, §6
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { resolve } from "node:path";
import express, {
  type Express,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
  type NextFunction,
  type RequestHandler,
} from "express";
import helmet from "helmet";
import { noopLogger, type Logger } from "@dwk/log";
import {
  installCryptoDigestStream,
  installHTMLRewriter,
  installWebSocketGlobals,
  type QueueBroker,
  type CronScheduler,
} from "@dwk/cf-shims";
import { sendWebResponse, toWebRequest } from "./adapter.js";
import { HostExecutionContext, WaitUntilTracker } from "./context.js";
import { installRequestDuplex } from "./request-duplex.js";
import { attachWebSocketUpgrade } from "./web-socket-upgrade.js";
import { acquireWriterLock, type ReleaseLock } from "./lock.js";
import { assertNoLocalStores } from "./central-mode.js";
import {
  assertBindings,
  isReservedPath,
  resolveOrigin,
  type HostConfig,
  type Mount,
} from "./config.js";

/** Internal wiring handed to {@link DwkServer}. */
interface ServerParts {
  readonly app: Express;
  readonly origin: string;
  readonly release: ReleaseLock | null;
  readonly tracker: WaitUntilTracker;
  readonly mounts: readonly Mount[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly queue?: QueueBroker;
  readonly cron?: CronScheduler;
  readonly logger: Logger;
}

/** A composed, runnable host. */
export class DwkServer {
  /** The underlying Express app — mount it elsewhere if you need to. */
  readonly app: Express;
  /** The validated public origin requests are reconstructed against. */
  readonly origin: string;

  readonly #release: ReleaseLock | null;
  readonly #tracker: WaitUntilTracker;
  readonly #mounts: readonly Mount[];
  readonly #env: Readonly<Record<string, unknown>>;
  readonly #queue?: QueueBroker;
  readonly #cron?: CronScheduler;
  readonly #logger: Logger;
  #httpServer: Server | null = null;
  #wsCleanup: (() => void) | null = null;

  constructor(parts: ServerParts) {
    this.app = parts.app;
    this.origin = parts.origin;
    this.#release = parts.release;
    this.#tracker = parts.tracker;
    this.#mounts = parts.mounts;
    this.#env = parts.env;
    this.#queue = parts.queue;
    this.#cron = parts.cron;
    this.#logger = parts.logger;
  }

  /** Start listening and the lifecycle workers (queue/cron). Resolves the bound port. */
  async listen(port = 0, host?: string): Promise<{ port: number }> {
    this.#queue?.start();
    this.#cron?.start();
    const server = createHttpServer(this.app);
    this.#httpServer = server;
    // WebSocket upgrades (e.g. Solid notifications) bypass Express; bridge them
    // straight to the matching mount's Durable Object.
    this.#wsCleanup = attachWebSocketUpgrade(server, {
      mounts: this.#mounts,
      env: this.#env,
      origin: this.origin,
      tracker: this.#tracker,
      logger: this.#logger,
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    this.#logger.info("server.listening", { port: bound });
    return { port: bound };
  }

  /**
   * Graceful shutdown: stop accepting connections, stop the queue/cron loops,
   * drain outstanding `waitUntil` work, then release the single-writer lock.
   */
  async close(): Promise<void> {
    // Detach the upgrade listener and close any open WebSocket connections first,
    // so they do not keep the HTTP server from closing.
    this.#wsCleanup?.();
    this.#wsCleanup = null;
    const server = this.#httpServer;
    if (server !== null) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
      });
      this.#httpServer = null;
    }
    await this.#cron?.stop();
    await this.#queue?.stop();
    await this.#tracker.drain();
    this.#release?.();
    this.#logger.info("server.closed");
  }
}

/**
 * Build a {@link DwkServer} from a {@link HostConfig}. Validates the base URL
 * and required bindings (fail loud), acquires the single-writer lock, and wires
 * the Express app with the documented routing precedence.
 */
export function createServer(config: HostConfig): DwkServer {
  const logger = config.logger ?? noopLogger;
  const origin = resolveOrigin(config.baseUrl, config.devMode ?? false);
  assertBindings(config.mounts, config.env);
  // Install the workerd runtime parity shims packages rely on: the `HTMLRewriter`
  // global (webmention/microsub HTML scanning) and a `Request` that defaults
  // `duplex` for streaming bodies (DO sub-request forwarding).
  installHTMLRewriter();
  installRequestDuplex();
  installWebSocketGlobals();
  installCryptoDigestStream();

  // Central mode: replicas are supposed to coexist (the per-id lease, once
  // Durable Objects land in phase 3, is the single-writer mechanism there),
  // so the local-writer lockfile is never acquired — but a `dataDir` still
  // holding local-mode authoritative stores means a half-migrated deployment,
  // which is refused loudly rather than silently corrupted (spec/scale-out.md
  // §9.3).
  const centralMode = config.storage?.mode === "central";
  if (centralMode) assertNoLocalStores(config.dataDir);
  const release =
    !centralMode && (config.lock ?? true)
      ? acquireWriterLock(config.dataDir)
      : null;
  const tracker = config.tracker ?? new WaitUntilTracker();

  const app = express();
  app.disable("x-powered-by");
  // Baseline security headers (nosniff, frame-options, HSTS, referrer-policy,
  // …) on every response, including proxied fetch-handler ones. CSP is left
  // off: `publicDir` can serve an arbitrary self-hosted site, and helmet's
  // default directives would break inline scripts/styles on content this
  // package doesn't control the shape of. A reverse proxy in front of this
  // container may set its own copy of these — that's harmless duplication,
  // not a conflict.
  //
  // `crossOriginResourcePolicy` is relaxed to "cross-origin": helmet's default
  // ("same-origin") would block a browser from directly fetching this host's
  // discovery documents — WebFinger `.well-known/webfinger`, ActivityPub actor
  // documents, IndieAuth metadata — from another origin, which several of the
  // `@dwk` protocols this host composes are explicitly designed to allow.
  // This host has no fixed set of mounted packages to reason a narrower,
  // per-route policy from, so the blanket relaxation is the composer-neutral
  // choice; a deployer who does need to restrict specific routes can add its
  // own middleware ahead of theirs.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(reservedDispatch(config.mounts, config.env, origin, tracker, logger));
  if (config.publicDir !== undefined) {
    // `dotfiles: "deny"` is explicit rather than relying on express.static's
    // default ("ignore", which just falls through to the next middleware) —
    // a dotfile (`.env`, `.git/…`) must never be served regardless of what a
    // composition's fallback route happens to do.
    app.use(express.static(resolve(config.publicDir), { dotfiles: "deny" }));
  }
  app.use(config.fallback ?? defaultFallback(config));

  return new DwkServer({
    app,
    origin,
    release,
    tracker,
    mounts: config.mounts,
    env: config.env,
    queue: config.queue,
    cron: config.cron,
    logger,
  });
}

/**
 * Middleware dispatching reserved protocol paths to the matching mount's fetch
 * handler. Non-reserved paths fall through (`next()`) to static + fallback.
 */
function reservedDispatch(
  mounts: readonly Mount[],
  env: Readonly<Record<string, unknown>>,
  origin: string,
  tracker: WaitUntilTracker,
  logger: Logger,
): RequestHandler {
  return (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const pathname = new URL(req.originalUrl, origin).pathname;
    const mount = mounts.find((m) => isReservedPath(pathname, m.reservedPaths));
    if (mount === undefined) {
      next();
      return;
    }
    void dispatch(mount, req, res, env, origin, tracker, logger);
  };
}

async function dispatch(
  mount: Mount,
  req: ExpressRequest,
  res: ExpressResponse,
  env: Readonly<Record<string, unknown>>,
  origin: string,
  tracker: WaitUntilTracker,
  logger: Logger,
): Promise<void> {
  try {
    const request = toWebRequest(req, origin);
    const ctx = new HostExecutionContext(tracker);
    // `env` is the assembled host Env; the handler's specific Env fragment is a
    // structural subset, so the `never` parameter is widened here at the call.
    const response = await mount.handler(request, env as never, ctx);
    await sendWebResponse(res, response);
  } catch (err) {
    logger.error("server.handler_error", {
      mount: mount.name,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) res.status(500).end();
    else res.end();
  }
}

/** The default fallback: a 404, or an SPA `index.html` rewrite if configured. */
function defaultFallback(config: HostConfig): RequestHandler {
  if (config.spaFallback && config.publicDir !== undefined) {
    const index = resolve(config.publicDir, "index.html");
    return (req: ExpressRequest, res: ExpressResponse) => {
      if (req.method === "GET" || req.method === "HEAD") {
        res.sendFile(index, (err: unknown) => {
          if (err) res.status(404).end();
        });
      } else {
        res.status(404).end();
      }
    };
  }
  return (_req: ExpressRequest, res: ExpressResponse) => {
    res.status(404).type("txt").send("Not Found");
  };
}
