import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWriterLock, DataDirectoryLockedError } from "./lock.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "dwk-lock-"));
}

const LOCK_FILE = ".dwk-writer.lock";

describe("single-writer lock", () => {
  it("acquires, then refuses a second writer, then re-acquires after release", () => {
    const dir = join(freshDir(), "data");
    const release = acquireWriterLock(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);

    expect(() => acquireWriterLock(dir)).toThrow(DataDirectoryLockedError);

    release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    // Re-acquire succeeds now that the lock is gone.
    acquireWriterLock(dir)();
  });

  it("reclaims a stale lock left by a dead process", () => {
    const dir = freshDir();
    // A pid that is almost certainly not running.
    writeFileSync(join(dir, LOCK_FILE), "999999");
    const release = acquireWriterLock(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    release();
  });

  it("creates the data directory 0700", () => {
    const dir = join(freshDir(), "nested", "data");
    acquireWriterLock(dir)();
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("release is idempotent", () => {
    const dir = freshDir();
    const release = acquireWriterLock(dir);
    release();
    expect(() => release()).not.toThrow();
  });
});
