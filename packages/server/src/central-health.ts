/**
 * Central-mode health surfaces (spec/scale-out.md §12): a liveness endpoint
 * (process up) and a readiness endpoint that re-runs the §9.2 startup probes
 * cheaply and caches the result for a few seconds, so an orchestrator can
 * pull an unhealthy replica from the load balancer without killing its
 * in-flight work.
 *
 * Returned as ordinary `Mount`s — the same shape every endpoint package
 * exposes — rather than a bespoke Express route, so a central-mode deployer
 * just spreads {@link createCentralHealthMounts}'s result into
 * `HostConfig.mounts` alongside everything else; no second wiring mechanism
 * to learn.
 *
 * @see spec/scale-out.md §12 (issue #433)
 */

import { noopLogger, type Logger } from "@dwk/log";
import {
  probeCentralStores,
  StartupProbeError,
  type StartupProbeTargets,
} from "./central-mode.js";
import type { FetchHandler, Mount } from "./config.js";

export interface CentralHealthOptions {
  /** The same stores `probeCentralStores` checks at startup — re-checked here on a cache. */
  readonly probeTargets: StartupProbeTargets;
  /** How long a readiness result is cached before re-probing (default 2000ms). */
  readonly cacheMs?: number;
  /** Reserved path for the liveness endpoint (default `/healthz`). */
  readonly livenessPath?: string;
  /** Reserved path for the readiness endpoint (default `/readyz`). */
  readonly readinessPath?: string;
  /** Clock source, for deterministic tests. */
  readonly now?: () => number;
  readonly logger?: Logger;
}

function livenessHandler(): FetchHandler {
  return (async () => new Response("ok", { status: 200 })) as FetchHandler;
}

function readinessHandler(options: CentralHealthOptions): FetchHandler {
  const cacheMs = options.cacheMs ?? 2000;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? noopLogger;
  let checkedAt = -Infinity;
  let healthy = true;
  let failures: readonly { readonly store: string; readonly error: string }[] =
    [];

  return (async () => {
    const t = now();
    if (t - checkedAt >= cacheMs) {
      checkedAt = t;
      const wasHealthy = healthy;
      try {
        await probeCentralStores(options.probeTargets);
        healthy = true;
        failures = [];
      } catch (err) {
        healthy = false;
        failures = err instanceof StartupProbeError ? err.failures : [];
        if (wasHealthy) {
          logger.warn("central_health.probe_failed", {
            failures: failures.map((f) => `${f.store}: ${f.error}`).join("; "),
          });
        }
      }
      if (healthy && !wasHealthy) {
        logger.info("central_health.probe_recovered", {});
      }
    }
    return healthy
      ? new Response("ok", { status: 200 })
      : new Response(JSON.stringify({ ok: false, failures }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
  }) as FetchHandler;
}

/**
 * Build the liveness + readiness `Mount`s for a central-mode deployment.
 * Liveness always reports `200` while the process is up (no store round
 * trips — that would make liveness fail the same way readiness does, which
 * defeats the point of having both). Readiness re-runs
 * {@link probeCentralStores} against `options.probeTargets`, cached for
 * `options.cacheMs`.
 */
export function createCentralHealthMounts(
  options: CentralHealthOptions,
): readonly Mount[] {
  return [
    {
      name: "@dwk/server:health-live",
      handler: livenessHandler(),
      reservedPaths: [options.livenessPath ?? "/healthz"],
    },
    {
      name: "@dwk/server:health-ready",
      handler: readinessHandler(options),
      reservedPaths: [options.readinessPath ?? "/readyz"],
    },
  ];
}
