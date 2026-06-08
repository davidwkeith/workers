/**
 * Single-writer lockfile over the data directory.
 *
 * The self-host correctness story rests on one invariant: **exactly one process
 * writes a given data directory** (§8). Two Node processes sharing a SQLite file
 * and a Durable-Object mutex would each believe they are the single writer for a
 * pod and corrupt the consistency/authz model. This module enforces that with an
 * exclusive lockfile acquired at startup; a stale lock from a dead process is
 * reclaimed automatically.
 *
 * @see spec/self-hosting.md §8
 */

import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_FILE = ".dwk-writer.lock";

/** Raised when another live process already holds the data-directory lock. */
export class DataDirectoryLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly holderPid: number,
  ) {
    super(
      `data directory ${dataDir} is locked by another @dwk/server process ` +
        `(pid ${holderPid}); the single-writer invariant forbids a second ` +
        `writer — clustering is unsupported (see spec/self-hosting.md §8)`,
    );
    this.name = "DataDirectoryLockedError";
  }
}

/** Releases an acquired lock. Idempotent and safe to call during shutdown. */
export type ReleaseLock = () => void;

/**
 * Acquire the single-writer lock on `dataDir`, creating the directory `0700` if
 * needed. Returns a release function. Throws {@link DataDirectoryLockedError} if
 * a live process already holds it; a lock left by a dead process is reclaimed.
 */
export function acquireWriterLock(dataDir: string): ReleaseLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, LOCK_FILE);

  let fd = tryCreate(lockPath);
  if (fd === null) {
    const holder = readHolderPid(lockPath);
    if (holder !== null && isProcessAlive(holder)) {
      throw new DataDirectoryLockedError(dataDir, holder);
    }
    // An empty lockfile may belong to a process that created it micro-seconds
    // ago but hasn't written its pid yet (the create→write window). Treat a
    // very recent pid-less lock as held rather than stealing it (TOCTOU guard).
    if (holder === null && lockAgeMs(lockPath) < 5000) {
      throw new DataDirectoryLockedError(dataDir, -1);
    }
    // Stale lock (holder dead or unreadable) — reclaim it.
    tolerantUnlink(lockPath);
    fd = tryCreate(lockPath);
    if (fd === null) {
      // Lost a race to another starting process.
      const racer = readHolderPid(lockPath);
      throw new DataDirectoryLockedError(dataDir, racer ?? -1);
    }
  }

  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone — nothing to release.
    }
  };
}

/** Age of the lockfile in ms, or `Infinity` if it has vanished. */
function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** `unlink` that ignores a file that another process already removed. */
function tolerantUnlink(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** `open` with `wx` (O_CREAT|O_EXCL): succeeds only if the file does not exist. */
function tryCreate(lockPath: string): number | null {
  try {
    return openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` probes liveness without delivering a signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
