/**
 * `central` storage mode: the mode guard and fail-loud startup probes that
 * replace the local-writer lockfile's invariant for a fleet of replicas.
 *
 * `acquireWriterLock` (`lock.ts`) exists to stop two processes sharing local
 * files; central mode replicas are *supposed* to coexist (the per-id lease is
 * the single-writer mechanism once Durable Objects land in phase 3), so
 * `createServer` skips it entirely for a `central`-mode config. What replaces
 * it:
 *
 * - {@link assertNoLocalStores} — refuses a `dataDir` that still contains
 *   local-mode authoritative stores (`d1/`, `r2/`, `do/`), so a deployment
 *   cannot half-migrate by accident.
 * - {@link assertModeMarker} — writes/validates a `["dwk_meta", "mode"]`
 *   marker in the coordination KV, both directions: a store set is written
 *   under exactly one mode.
 * - {@link probeCentralStores} — a round-trip write/read/delete probe against
 *   the coordination KV, each D1 database, and the object store, run once at
 *   startup so an unreachable store is a clear startup error, not a
 *   first-request 500 — mirroring `assertBindings`' posture for local mode.
 *
 * @see spec/scale-out.md §9.2, §9.3 (issue #431)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { DenoKvLike } from "@dwk/deno-host";

/** Subdirectories `assembleBindings` (local mode) writes authoritative state under. */
const LOCAL_STORE_DIRS = ["d1", "r2", "do"] as const;

/** Raised when `dataDir` still holds local-mode authoritative stores. */
export class LocalStoreConflictError extends Error {
  constructor(
    readonly dataDir: string,
    readonly found: readonly string[],
  ) {
    super(
      `data directory ${dataDir} contains local-mode store(s) ` +
        `(${found.join(", ")}); central mode refuses to start against a ` +
        `directory that might still hold authoritative local-mode state — ` +
        `migrate or point at a fresh dataDir (see spec/scale-out.md §9.3)`,
    );
    this.name = "LocalStoreConflictError";
  }
}

/**
 * Refuse a `dataDir` containing local-mode authoritative stores (`d1/`,
 * `r2/`, `do/`). Purely local filesystem check — no network — so it runs
 * synchronously as part of `createServer`'s existing fail-loud startup path.
 */
export function assertNoLocalStores(dataDir: string): void {
  const found = LOCAL_STORE_DIRS.filter((sub) =>
    existsSync(join(dataDir, sub)),
  );
  if (found.length > 0) throw new LocalStoreConflictError(dataDir, found);
}

const MODE_MARKER_KEY = ["dwk_meta", "mode"] as const;

/** Raised when the coordination KV's mode marker disagrees with this replica. */
export class ModeMarkerConflictError extends Error {
  constructor(
    readonly recorded: string,
    readonly attempted: string,
  ) {
    super(
      `coordination store's mode marker is ${JSON.stringify(recorded)} but ` +
        `this replica is starting in ${JSON.stringify(attempted)} mode — a ` +
        `store set may only be written under one mode at a time ` +
        `(see spec/scale-out.md §9.3)`,
    );
    this.name = "ModeMarkerConflictError";
  }
}

/**
 * Write (if absent) or validate (if present) the coordination KV's
 * `["dwk_meta", "mode"]` marker. Every replica in a fleet calls this at
 * startup; the first one to run writes the marker, and every subsequent
 * replica (here or on a later restart) just confirms it still reads
 * `"central"`. Throws {@link ModeMarkerConflictError} on a mismatch.
 */
export async function assertModeMarker(kv: DenoKvLike): Promise<void> {
  const existing = await kv.get<string>(MODE_MARKER_KEY);
  if (existing.value === null) {
    await kv.set(MODE_MARKER_KEY, "central");
    return;
  }
  if (existing.value !== "central") {
    throw new ModeMarkerConflictError(existing.value, "central");
  }
}

/** One store's probe failure. */
export interface StartupProbeFailure {
  readonly store: string;
  readonly error: string;
}

/** Raised when one or more central-mode stores fail their startup probe. */
export class StartupProbeError extends Error {
  constructor(readonly failures: readonly StartupProbeFailure[]) {
    const lines = failures.map((f) => `  - ${f.store}: ${f.error}`);
    super(`central-mode startup probes failed:\n${lines.join("\n")}`);
    this.name = "StartupProbeError";
  }
}

/** The stores a replica probes at startup before serving any request. */
export interface StartupProbeTargets {
  /** The coordination KV (lease/alarm/queue/mode-marker store). */
  readonly kv: DenoKvLike;
  /** D1 bindings to probe, keyed by binding name for a legible failure report. */
  readonly d1?: Readonly<Record<string, D1Database>>;
  /** The shared object store, if any package mounted needs R2. */
  readonly objectStore?: R2Bucket;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Round-trip write/read/delete every configured store and collect failures
 * rather than throwing on the first one, so a misconfigured replica reports
 * *every* unreachable store in one clear startup error instead of a
 * one-at-a-time trial-and-error loop. Throws {@link StartupProbeError} if any
 * probe failed; a caller (`dwk-serve`, a container's entrypoint) should let
 * that exception propagate to a non-zero exit so the orchestrator restarts
 * the replica rather than serving 500s.
 */
export async function probeCentralStores(
  targets: StartupProbeTargets,
): Promise<void> {
  const failures: StartupProbeFailure[] = [];

  try {
    const probeKey = ["dwk_meta", "probe", crypto.randomUUID()] as const;
    await targets.kv.set(probeKey, true);
    const read = await targets.kv.get<boolean>(probeKey);
    if (read.value !== true) {
      throw new Error("round-trip read did not return the written value");
    }
    await targets.kv.delete(probeKey);
  } catch (err) {
    failures.push({ store: "coordination-kv", error: errorMessage(err) });
  }

  for (const [name, db] of Object.entries(targets.d1 ?? {})) {
    try {
      await db.prepare("SELECT 1 AS ok").first();
    } catch (err) {
      failures.push({ store: `d1:${name}`, error: errorMessage(err) });
    }
  }

  if (targets.objectStore !== undefined) {
    try {
      const key = `.dwk-startup-probe-${crypto.randomUUID()}`;
      await targets.objectStore.put(key, "probe");
      const got = await targets.objectStore.get(key);
      if (got === null) throw new Error("put succeeded but get returned null");
      await targets.objectStore.delete(key);
    } catch (err) {
      failures.push({ store: "object-store", error: errorMessage(err) });
    }
  }

  if (failures.length > 0) throw new StartupProbeError(failures);
}
