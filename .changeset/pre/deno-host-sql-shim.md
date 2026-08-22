---
"@dwk/deno-host": minor
---

New package: Deno Deploy host building blocks (issue #397, the SQL gap of
the gated #396 plan). `createD1Database(client)` presents an async remote
libSQL/Turso client (`@libsql/client`) as a host-contract §3.5 `D1Database`
— `meta.changes` from `rowsAffected`, atomic in-order `batch` via
`client.batch(..., "write")`, `exec` via `executeMultiple`.
`createDurableSqlite(db)` / `createSqlStorage(db)` present libSQL's
synchronous embedded-replica client (or any better-sqlite3 /
`node:sqlite`-shaped handle) as the host-contract §3.2 `SqlStorage` +
`transactionSync` surface, with Cloudflare-style one-shot cursors. Both
shims are runtime-agnostic and dependency-free, reaching their store only
through injected structural client seams.
