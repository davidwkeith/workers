/**
 * Host configuration model + the startup invariants the host enforces.
 *
 * `@dwk/server` is the composition root — the one place allowed to read the
 * environment and assemble config (the packages themselves never read the global
 * environment). This module defines the typed host config, the `Mount`
 * descriptor that ties a fetch handler to the reserved paths it owns and the
 * bindings it requires, and the fail-loud assertions run at startup:
 *
 * - a mounted package's missing binding/secret is a clear startup error, not a
 *   first-request 500;
 * - identity is HTTPS-rooted, so a non-localhost `http://` base URL is refused
 *   outside an explicit dev mode.
 *
 * @see spec/self-hosting.md §9, §12
 */

import type { Logger } from "@dwk/log";
import type { RequestHandler } from "express";
import type { WaitUntilTracker } from "./context.js";
import type { QueueBroker, CronScheduler } from "@dwk/cf-shims";

/**
 * A runtime-neutral fetch handler. `env` is typed `never` so a handler written
 * against any concrete `Env` fragment (e.g. `IndieAuthEnv`) is assignable here
 * by contravariance; the host passes the assembled `Env` at call time.
 */
export type FetchHandler = (
  request: Request,
  env: never,
  ctx: ExecutionContext,
) => Promise<Response>;

/** One endpoint package mounted into the host. */
export interface Mount {
  /** Human-readable name for startup diagnostics (e.g. `"@dwk/indieauth"`). */
  readonly name?: string;
  /** The package's `createX(config)` fetch handler. */
  readonly handler: FetchHandler;
  /**
   * Paths this mount owns. An entry matches a request path exactly **or** as a
   * prefix of a subpath (`/media` matches `/media` and `/media/abc`). These win
   * over static files, so a static `/.well-known/webfinger` cannot shadow the
   * WebFinger endpoint. Derived from the same config the handler is built with,
   * so the reserved set cannot drift from where the handler actually listens.
   */
  readonly reservedPaths: readonly string[];
  /** `Env` keys that MUST be present, asserted at startup (fail loud). */
  readonly requires?: readonly string[];
}

/** Top-level host configuration. */
export interface HostConfig {
  /**
   * Public origin the deployment is reached at (e.g. `https://example.com`).
   * Used to build absolute request URLs — never the spoofable `Host` header.
   */
  readonly baseUrl: string;
  /** Root directory for SQLite databases, R2-on-disk objects, and the lock. */
  readonly dataDir: string;
  /** Directory of static files (the user's website) served after endpoints. */
  readonly publicDir?: string;
  /** The endpoint packages to mount. */
  readonly mounts: readonly Mount[];
  /** The assembled `Env`: every binding shim + secret the mounts declare. */
  readonly env: Readonly<Record<string, unknown>>;
  /**
   * Fallback for requests matched by neither an endpoint nor a static file.
   * Defaults to a 404 (or, with {@link spaFallback}, an `index.html` rewrite).
   */
  readonly fallback?: RequestHandler;
  /** Serve `publicDir/index.html` for unmatched GETs (SPA routing). */
  readonly spaFallback?: boolean;
  /** Permit a non-localhost `http://` base URL (insecure; dev only). */
  readonly devMode?: boolean;
  /** Acquire the single-writer data-directory lock at startup (default true). */
  readonly lock?: boolean;
  /** Structured logger; defaults to a no-op. */
  readonly logger?: Logger;
  /** Queue broker to run for the host lifecycle (Phase 3 consumers). */
  readonly queue?: QueueBroker;
  /** Cron scheduler to run for the host lifecycle (Phase 3 scheduled handlers). */
  readonly cron?: CronScheduler;
  /**
   * Tracker for `waitUntil` background work, drained on shutdown. Pass the same
   * instance to {@link bindQueueConsumer} / {@link bindScheduledTask} so a
   * consumer's or scheduled task's background work is drained at close.
   * Defaults to a fresh tracker owned by the server.
   */
  readonly tracker?: WaitUntilTracker;
}

/** Raised at startup when a mounted package's required binding is absent. */
export class MissingBindingError extends Error {
  constructor(
    readonly missing: ReadonlyArray<{ mount: string; binding: string }>,
  ) {
    const lines = missing.map(
      (m) => `  - ${m.mount} requires env.${m.binding}`,
    );
    super(`missing required bindings:\n${lines.join("\n")}`);
    this.name = "MissingBindingError";
  }
}

/** Raised at startup for an insecure base URL outside dev mode. */
export class InsecureBaseUrlError extends Error {
  constructor(readonly baseUrl: string) {
    super(
      `baseUrl ${baseUrl} is not HTTPS and not localhost; identity (issuer, ` +
        `WebID, post URLs) is HTTPS-rooted. Terminate TLS at a reverse proxy, ` +
        `or set devMode: true to allow this (insecure).`,
    );
    this.name = "InsecureBaseUrlError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate the base URL and return its origin. Throws
 * {@link InsecureBaseUrlError} for a non-localhost `http://` URL unless
 * `devMode` is set.
 */
export function resolveOrigin(baseUrl: string, devMode = false): string {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:") {
    if (devMode || LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(url.host)) {
      return url.origin;
    }
    throw new InsecureBaseUrlError(baseUrl);
  }
  throw new InsecureBaseUrlError(baseUrl);
}

/**
 * Assert every mount's required bindings are present in `env`. Throws
 * {@link MissingBindingError} listing all gaps so a misconfiguration surfaces at
 * startup rather than as a first-request 500.
 */
export function assertBindings(
  mounts: readonly Mount[],
  env: Readonly<Record<string, unknown>>,
): void {
  const missing: { mount: string; binding: string }[] = [];
  for (const mount of mounts) {
    for (const binding of mount.requires ?? []) {
      if (env[binding] === undefined || env[binding] === null) {
        missing.push({ mount: mount.name ?? "(unnamed mount)", binding });
      }
    }
  }
  if (missing.length > 0) throw new MissingBindingError(missing);
}

/**
 * Whether `pathname` is owned by a reserved-path entry: an exact match, or a
 * prefix followed by `/`.
 */
export function isReservedPath(
  pathname: string,
  reservedPaths: readonly string[],
): boolean {
  return reservedPaths.some(
    (entry) => pathname === entry || pathname.startsWith(`${entry}/`),
  );
}
