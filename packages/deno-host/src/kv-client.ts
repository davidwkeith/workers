/**
 * Injected Deno KV client seam (structural subset of `Deno.Kv`), backing the
 * KV-lease actor + alarm emulation (issue #398). The package never
 * constructs a `Deno.Kv` connection itself — the composing app injects one,
 * exactly like the libSQL seams in `client.ts`.
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

/** One key-part; `Deno.Kv` keys are arrays of these primitive types. */
export type KvKeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = readonly KvKeyPart[];

export interface DenoKvEntryLike<T = unknown> {
  readonly key: KvKey;
  readonly value: T;
  readonly versionstamp: string | null;
}

export interface DenoKvCheckLike {
  readonly key: KvKey;
  readonly versionstamp: string | null;
}

export interface DenoKvCommitResultLike {
  readonly ok: boolean;
  readonly versionstamp?: string;
}

export interface DenoKvAtomicLike {
  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike;
  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicLike;
  delete(key: KvKey): DenoKvAtomicLike;
  commit(): Promise<DenoKvCommitResultLike>;
}

export interface DenoKvListSelectorLike {
  readonly prefix: KvKey;
  readonly start?: KvKey;
  readonly end?: KvKey;
}

export interface DenoKvLike {
  get<T = unknown>(key: KvKey): Promise<DenoKvEntryLike<T>>;
  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }>;
  delete(key: KvKey): Promise<void>;
  list<T = unknown>(
    selector: DenoKvListSelectorLike,
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>>;
  atomic(): DenoKvAtomicLike;
}
