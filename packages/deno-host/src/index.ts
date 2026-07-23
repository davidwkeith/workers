/**
 * `@dwk/deno-host` — Deno Deploy host building blocks for the `@dwk`
 * packages: external libSQL/Turso presented behind the Cloudflare
 * `D1Database` and `SqlStorage` (Durable Object SQLite) interfaces.
 *
 * Like `@dwk/cf-shims`, this package is deliberately Cloudflare-interface-
 * shaped — emulating the binding contract is its entire purpose — but unlike
 * it, the implementation is runtime-agnostic: no `node:` imports, no Deno
 * globals, only injected client seams (`LibsqlClientLike` for the async
 * remote client, `SyncSqliteDatabaseLike` for the synchronous
 * embedded-replica client), so the same code runs on Deno Deploy, Node, or
 * anywhere else the composing app can supply a client.
 *
 * **Status: exploratory/gated.** This is the SQL gap (issue #397) of the
 * demand-gated `@dwk/deno-host` plan (#396); the actor/alarm (#398), queue
 * (#399), and object-storage (#400) gaps are not implemented here yet.
 *
 * @see spec/packages/deno-host.md
 */

export {
  normalizeBinding,
  type SqlValue,
  type LibsqlStatementLike,
  type LibsqlResultSetLike,
  type LibsqlTransactionMode,
  type LibsqlClientLike,
  type SyncSqliteStatementLike,
  type SyncSqliteDatabaseLike,
} from "./client.js";
export {
  type KvKeyPart,
  type KvKey,
  type DenoKvEntryLike,
  type DenoKvCheckLike,
  type DenoKvCommitResultLike,
  type DenoKvAtomicLike,
  type DenoKvListSelectorLike,
  type DenoKvLike,
} from "./kv-client.js";
export {
  acquireLease,
  releaseLease,
  LeaseContendedError,
  type Lease,
  type LeaseOptions,
} from "./lease.js";
export { createD1Database } from "./d1.js";
export {
  createSqlStorage,
  createDurableSqlite,
  SyncSqlStorage,
  SyncSqlCursor,
  type DurableSqlite,
} from "./sql-storage.js";
