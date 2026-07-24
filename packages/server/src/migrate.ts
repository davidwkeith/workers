/**
 * `dwk migrate` — mechanical local ↔ central data migration
 * (spec/scale-out.md §13, phase 5, issue #434).
 *
 * Local mode (`@dwk/cf-shims`) and central mode (`@dwk/deno-host`) store the
 * same logical data in the same SQLite dialect, so migration is a copy, not a
 * transform: D1/DO-SQLite ⇄ libSQL is dump-schema-then-replay-rows, R2 ⇄ an
 * S3-compatible store is a streamed `PUT`/`GET`, and the two sharp edges the
 * spec calls out are handled explicitly rather than silently dropped:
 *
 * - **Pending alarms** live *inside* each object's local SQLite file
 *   (`@dwk/cf-shims`'s `_host_alarm` table) but *outside* the per-object
 *   database in central mode (the coordination KV's due/by-id indexes,
 *   `@dwk/deno-host`'s `alarms.ts`) — {@link liftPendingAlarm} moves one, and
 *   every DO-object migration function calls it so this can't be forgotten.
 * - **Queue backlog** — {@link importQueueBacklog} imports pending local
 *   queue rows as KV due entries (the spec's documented alternative to
 *   draining the queue before migrating); `attempts` resets to 0, since a
 *   fresh delivery-attempt counter is safe for an at-least-once queue and no
 *   consumer depends on preserving it across a migration.
 *
 * `migrateLocalToCentral` scans a `dataDir` the same way `bindings.ts`
 * assembles one (`d1/<NAME>.sqlite`, `r2/<NAME>/`, `do/<ClassName>/<id>.sqlite`)
 * and migrates whatever the caller's `CentralMigrationTarget` declares
 * bindings for — the common "scale out" direction. Central mode has no
 * directory to scan (each D1 binding is one opaque logical database, each DO
 * object its own; there is no `list`, per `@dwk/deno-host`'s R2 shim doc),
 * so `migrateCentralToLocal` takes an explicit `LocalMigrationTarget`
 * naming exactly what to pull down instead of discovering it.
 *
 * Every function here operates on **injected clients** — this module never
 * constructs a libSQL/S3 connection, matching every other `@dwk/deno-host`
 * seam consumer in this package.
 *
 * @see spec/scale-out.md §13
 */

import { DatabaseSync } from "node:sqlite";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { noopLogger, type Logger } from "@dwk/log";
import {
  createQueueBroker,
  createS3Bucket,
  getAlarm,
  normalizeBinding,
  setAlarm,
  type DenoKvLike,
  type LibsqlClientLike,
  type LibsqlStatementLike,
  type S3ClientLike,
  type SqlValue,
  type SyncSqliteDatabaseLike,
} from "@dwk/deno-host";

/* ---------- generic SQLite dump/replay (D1 and DO-SQLite share this) ---------- */

export interface TableDump {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/** A schema + full-table-contents snapshot, in dependency order (tables first). */
export interface SqliteDump {
  readonly ddl: readonly string[];
  readonly tables: readonly TableDump[];
}

export interface DumpOptions {
  /** Table names to omit entirely (e.g. `@dwk/cf-shims`'s internal `_host_alarm`). */
  readonly excludeTables?: readonly string[];
}

const SCHEMA_QUERY =
  "SELECT type, name, sql FROM sqlite_master " +
  "WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL " +
  "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END";

interface SyncQueryable {
  prepare(sql: string): { all(...args: SqlValue[]): unknown[] };
}

function dumpSyncDatabase(db: SyncQueryable, options: DumpOptions): SqliteDump {
  const exclude = new Set(options.excludeTables ?? []);
  const schemaRows = db.prepare(SCHEMA_QUERY).all() as Record<
    string,
    unknown
  >[];
  const ddl: string[] = [];
  const tables: TableDump[] = [];
  for (const row of schemaRows) {
    const type = String(row["type"]);
    const name = String(row["name"]);
    if (exclude.has(name)) continue;
    ddl.push(String(row["sql"]));
    if (type === "table") {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<
        string,
        unknown
      >[];
      tables.push({ name, columns: rows[0] ? Object.keys(rows[0]) : [], rows });
    }
  }
  return { ddl, tables };
}

/** Dump every table's schema + rows from a local `node:sqlite` file. */
export function dumpLocalSqlite(
  path: string,
  options: DumpOptions = {},
): SqliteDump {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return dumpSyncDatabase(db, options);
  } finally {
    db.close();
  }
}

/** Dump every table's schema + rows from an injected synchronous storage client
 *  (a central-mode DO's embedded-replica connection). */
export function dumpSyncStorage(
  db: SyncSqliteDatabaseLike,
  options: DumpOptions = {},
): SqliteDump {
  return dumpSyncDatabase(db, options);
}

/** Dump every table's schema + rows from an injected async libSQL client (D1). */
export async function dumpFromAsyncClient(
  client: LibsqlClientLike,
  options: DumpOptions = {},
): Promise<SqliteDump> {
  const exclude = new Set(options.excludeTables ?? []);
  const schema = await client.execute({ sql: SCHEMA_QUERY, args: [] });
  const ddl: string[] = [];
  const tables: TableDump[] = [];
  for (const row of schema.rows) {
    const type = String(row["type"]);
    const name = String(row["name"]);
    if (exclude.has(name)) continue;
    ddl.push(String(row["sql"]));
    if (type === "table") {
      const result = await client.execute({
        sql: `SELECT * FROM "${name}"`,
        args: [],
      });
      const rows = result.rows as Record<string, unknown>[];
      tables.push({ name, columns: rows[0] ? Object.keys(rows[0]) : [], rows });
    }
  }
  return { ddl, tables };
}

function replayIntoSyncDatabase(
  db: {
    exec(sql: string): unknown;
    prepare(sql: string): { run(...args: SqlValue[]): unknown };
  },
  dump: SqliteDump,
): void {
  db.exec("BEGIN");
  try {
    for (const ddl of dump.ddl) db.exec(ddl);
    for (const table of dump.tables) {
      if (table.rows.length === 0) continue;
      const cols = table.columns.map((c) => `"${c}"`).join(", ");
      const placeholders = table.columns.map(() => "?").join(", ");
      const stmt = db.prepare(
        `INSERT INTO "${table.name}" (${cols}) VALUES (${placeholders})`,
      );
      for (const row of table.rows) {
        stmt.run(...table.columns.map((c) => normalizeBinding(row[c])));
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Replay a dump into a (possibly fresh) local `node:sqlite` file. */
export function replayIntoLocalSqlite(path: string, dump: SqliteDump): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    replayIntoSyncDatabase(db, dump);
  } finally {
    db.close();
  }
}

/** Replay a dump into an injected synchronous storage client. */
export function replayIntoSyncStorage(
  db: SyncSqliteDatabaseLike,
  dump: SqliteDump,
): void {
  replayIntoSyncDatabase(db, dump);
}

/**
 * Replay a dump into an injected async libSQL client as **one** `batch`
 * call — DDL and every table's row inserts, in order, in the single
 * implicit transaction `LibsqlClientLike#batch(..., "write")` guarantees
 * (host-contract §3.5's atomic-`batch` rule). This is deliberately not one
 * call per table: a mid-dump failure (a network blip, a constraint
 * violation) must leave the target database exactly as it was before the
 * call, not partially populated with tables 1..N-1 committed and nothing
 * to retry against — a caller can safely re-run this function on failure.
 */
export async function replayIntoAsyncClient(
  client: LibsqlClientLike,
  dump: SqliteDump,
): Promise<void> {
  const statements: LibsqlStatementLike[] = dump.ddl.map((sql) => ({
    sql,
    args: [],
  }));
  for (const table of dump.tables) {
    if (table.rows.length === 0) continue;
    const cols = table.columns.map((c) => `"${c}"`).join(", ");
    const placeholders = table.columns.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table.name}" (${cols}) VALUES (${placeholders})`;
    for (const row of table.rows) {
      statements.push({
        sql,
        args: table.columns.map((c) => normalizeBinding(row[c])),
      });
    }
  }
  if (statements.length === 0) return;
  await client.batch(statements, "write");
}

function countRows(dump: SqliteDump): number {
  return dump.tables.reduce((n, t) => n + t.rows.length, 0);
}

/* ---------- D1 ---------- */

export interface D1MigrationReport {
  readonly tables: number;
  readonly rows: number;
}

/** Migrate one local D1 SQLite file into an injected central libSQL client. */
export async function migrateD1ToCentral(
  localPath: string,
  client: LibsqlClientLike,
): Promise<D1MigrationReport> {
  const dump = dumpLocalSqlite(localPath);
  await replayIntoAsyncClient(client, dump);
  return { tables: dump.tables.length, rows: countRows(dump) };
}

/** Migrate an injected central libSQL client's database into a local D1
 *  SQLite file (created fresh if it does not already exist). */
export async function migrateD1ToLocal(
  client: LibsqlClientLike,
  localPath: string,
): Promise<D1MigrationReport> {
  const dump = await dumpFromAsyncClient(client);
  replayIntoLocalSqlite(localPath, dump);
  return { tables: dump.tables.length, rows: countRows(dump) };
}

/* ---------- Durable Object SQLite + pending alarms ---------- */

/** The shim-owned table `@dwk/cf-shims` persists a DO's pending alarm in —
 *  see `packages/cf-shims/src/durable-object.ts`'s `ALARM_TABLE_DDL`. */
const ALARM_TABLE = "_host_alarm";

const LOCAL_ALARM_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS ${ALARM_TABLE} ` +
  "(id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL)";

/** Whether `err` is `node:sqlite`'s "no such table" error for `_host_alarm`
 *  specifically, not some other `ERR_SQLITE_ERROR` (a locked file, a
 *  permissions issue, an unexpected schema). */
function isMissingAlarmTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    err.message.includes(`no such table: ${ALARM_TABLE}`)
  );
}

/**
 * Lift a local DO object's pending alarm (if any) into the central
 * coordination KV's due/by-id indexes (`@dwk/deno-host`'s `setAlarm`) —
 * spec/scale-out.md §13's "pending alarms MUST be lifted" edge case. Returns
 * whether an alarm was found and lifted.
 */
export async function liftPendingAlarm(
  localSqlitePath: string,
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<boolean> {
  const db = new DatabaseSync(localSqlitePath, { readOnly: true });
  let scheduledTime: number | null;
  try {
    const row = db
      .prepare(`SELECT scheduled_time AS t FROM ${ALARM_TABLE} WHERE id = 1`)
      .get() as { t: number | bigint } | undefined;
    scheduledTime = row === undefined ? null : Number(row.t);
  } catch (err) {
    // No `_host_alarm` table at all means the object never set an alarm —
    // narrowed to exactly that case (node:sqlite's ERR_SQLITE_ERROR with a
    // "no such table" message) so a real failure (a locked/corrupt file, an
    // unexpected schema) propagates instead of being silently read back as
    // "no pending alarm," which would drop a real one.
    if (!isMissingAlarmTableError(err)) throw err;
    scheduledTime = null;
  } finally {
    db.close();
  }
  if (scheduledTime === null) return false;
  await setAlarm(kv, className, idHex, scheduledTime);
  return true;
}

/**
 * Lower a central DO object's pending alarm (if any), read from the
 * coordination KV, back into a local object's `_host_alarm` table — the
 * `to-local` direction's counterpart to {@link liftPendingAlarm}.
 */
async function lowerPendingAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  localSqlitePath: string,
): Promise<boolean> {
  const epochMs = await getAlarm(kv, className, idHex);
  if (epochMs === null) return false;
  const db = new DatabaseSync(localSqlitePath);
  try {
    db.exec(LOCAL_ALARM_TABLE_DDL);
    db.prepare(
      "INSERT INTO _host_alarm (id, scheduled_time) VALUES (1, ?) " +
        "ON CONFLICT (id) DO UPDATE SET scheduled_time = excluded.scheduled_time",
    ).run(epochMs);
  } finally {
    db.close();
  }
  return true;
}

export interface DoMigrationReport extends D1MigrationReport {
  readonly alarmLifted: boolean;
}

/**
 * Migrate one local DO object's SQLite file into an injected central
 * embedded-replica storage client, then lift its pending alarm (if any) into
 * the coordination KV.
 */
export async function migrateDoObjectToCentral(
  localSqlitePath: string,
  storage: SyncSqliteDatabaseLike,
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<DoMigrationReport> {
  const dump = dumpLocalSqlite(localSqlitePath, {
    excludeTables: [ALARM_TABLE],
  });
  replayIntoSyncStorage(storage, dump);
  const alarmLifted = await liftPendingAlarm(
    localSqlitePath,
    kv,
    className,
    idHex,
  );
  return { tables: dump.tables.length, rows: countRows(dump), alarmLifted };
}

/**
 * Migrate a central DO object's embedded-replica storage into a local
 * `<dataDir>/do/<className>/<idHex>.sqlite` file, then lower its pending
 * alarm (if any) from the coordination KV back into the file.
 */
export async function migrateDoObjectToLocal(
  storage: SyncSqliteDatabaseLike,
  localSqlitePath: string,
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<DoMigrationReport> {
  const dump = dumpSyncStorage(storage, { excludeTables: [ALARM_TABLE] });
  replayIntoLocalSqlite(localSqlitePath, dump);
  const alarmLifted = await lowerPendingAlarm(
    kv,
    className,
    idHex,
    localSqlitePath,
  );
  return { tables: dump.tables.length, rows: countRows(dump), alarmLifted };
}

/* ---------- R2 ---------- */

export interface R2MigrationReport {
  readonly objects: number;
  readonly bytes: number;
}

interface LocalR2Meta {
  readonly size: number;
  readonly etag: string;
  readonly version: string;
  readonly uploaded: string;
  readonly contentType?: string;
  readonly customMetadata?: Record<string, string>;
}

/** Sidecar suffix `@dwk/cf-shims`'s R2 shim writes metadata under. */
const R2_META_SUFFIX = ".r2meta";

/** Resolve `key` under `root`, refusing a `..`/absolute key that would
 *  escape it — the same guard `@dwk/cf-shims`'s `FsR2Bucket#keyToPath`
 *  applies. `key` is caller-supplied (see {@link migrateR2ToLocal}'s doc
 *  comment on why there is no generic discovery), so this defends a future
 *  caller that sources keys less carefully than today's trusted ones. */
function resolveR2Path(root: string, key: string): string {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, key);
  if (path !== resolvedRoot && !path.startsWith(resolvedRoot + sep)) {
    throw new Error(`R2 key escapes the local bucket root: ${key}`);
  }
  return path;
}

/** Recursively collect object keys under `root` (mirrors `@dwk/cf-shims`'s
 *  `FsR2Bucket#walk`, standalone since there is no bucket instance here). */
function walkR2Objects(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith(R2_META_SUFFIX)) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out;
}

export interface CentralR2Target {
  readonly client: S3ClientLike;
  readonly endpoint: string;
}

/**
 * Migrate every object under a local R2 bucket directory into an injected
 * central S3-compatible bucket, preserving content-type and custom metadata.
 * Streams each object's body — no full-file buffering.
 */
export async function migrateR2ToCentral(
  localRoot: string,
  bucket: CentralR2Target,
): Promise<R2MigrationReport> {
  const keys = walkR2Objects(localRoot);
  const target = createS3Bucket(bucket);
  let bytes = 0;
  for (const key of keys) {
    const meta = JSON.parse(
      readFileSync(join(localRoot, `${key}${R2_META_SUFFIX}`), "utf8"),
    ) as LocalR2Meta;
    const body = Readable.toWeb(
      createReadStream(join(localRoot, key)),
    ) as unknown as ReadableStream;
    await target.put(key, body, {
      httpMetadata: meta.contentType
        ? { contentType: meta.contentType }
        : undefined,
      customMetadata: meta.customMetadata,
    });
    bytes += meta.size;
  }
  return { objects: keys.length, bytes };
}

/**
 * Migrate explicitly-named objects from an injected central S3-compatible
 * bucket into a local R2 bucket directory, writing the same file + `.r2meta`
 * sidecar shape `@dwk/cf-shims`'s R2 shim itself writes.
 *
 * Central mode's `S3ClientLike` seam deliberately has no `list` (per
 * `@dwk/deno-host`'s r2.ts doc comment — no production consumer needs it),
 * so unlike `migrateR2ToCentral` this direction cannot discover its own key
 * set; the caller supplies `keys` (e.g. from `@dwk/store`'s own D1 registry
 * of the keys it wrote).
 */
export async function migrateR2ToLocal(
  bucket: CentralR2Target,
  localRoot: string,
  keys: readonly string[],
): Promise<R2MigrationReport> {
  const source = createS3Bucket(bucket);
  let bytes = 0;
  let migrated = 0;
  for (const key of keys) {
    const object = await source.get(key);
    if (object === null) continue;
    const path = resolveR2Path(localRoot, key);
    mkdirSync(dirname(path), { recursive: true });
    await pipeline(
      Readable.fromWeb(
        object.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
      createWriteStream(path),
    );
    const meta: LocalR2Meta = {
      size: object.size,
      etag: object.etag,
      version: object.version,
      uploaded: object.uploaded.toISOString(),
      contentType: object.httpMetadata?.contentType,
      customMetadata: object.customMetadata,
    };
    writeFileSync(`${path}${R2_META_SUFFIX}`, JSON.stringify(meta));
    bytes += object.size;
    migrated += 1;
  }
  return { objects: migrated, bytes };
}

/* ---------- Queue backlog ---------- */

export interface QueueMigrationReport {
  readonly imported: number;
  readonly dropped: number;
}

interface LocalQueueRow {
  readonly id: number;
  readonly queue: string;
  readonly body: string;
  readonly attempts: number;
  readonly visible_at: number;
}

/**
 * Import a local durable queue's non-dead backlog into the central
 * coordination KV as due entries (spec/scale-out.md §13's documented
 * alternative to draining the queue before migrating). Each message's
 * `attempts` counter resets to 0 — safe for an at-least-once queue, and no
 * `@dwk` consumer depends on preserving it across a migration. A message
 * whose stored body fails to parse is dropped rather than imported broken.
 *
 * Each row is marked `dead = 1` in the local queue **immediately after** its
 * `send` succeeds — both so a local consumer never redelivers a message that
 * has already moved to central mode (running both would double-deliver),
 * and so this function is safe to re-run after a partial failure: an
 * interrupted run leaves already-sent rows marked dead (not re-sent) and
 * picks the rest up on retry, rather than re-enqueueing every previously
 * -imported message a second time.
 */
export async function importQueueBacklog(
  localQueueDbPath: string,
  kv: DenoKvLike,
  options: { readonly now?: () => number } = {},
): Promise<QueueMigrationReport> {
  const db = new DatabaseSync(localQueueDbPath);
  const markMigrated = db.prepare(
    "UPDATE queue_jobs SET dead = 1 WHERE id = ?",
  );
  let rows: LocalQueueRow[];
  try {
    rows = db
      .prepare(
        "SELECT id, queue, body, attempts, visible_at FROM queue_jobs WHERE dead = 0",
      )
      .all() as unknown as LocalQueueRow[];

    const now = options.now?.() ?? Date.now();
    const broker = createQueueBroker(kv, options);
    let imported = 0;
    let dropped = 0;
    for (const row of rows) {
      let body: unknown;
      try {
        body = JSON.parse(row.body);
      } catch {
        markMigrated.run(row.id);
        dropped += 1;
        continue;
      }
      const delaySeconds = Math.max(
        0,
        Math.round((row.visible_at - now) / 1000),
      );
      await broker.producer(row.queue).send(body, { delaySeconds });
      markMigrated.run(row.id);
      imported += 1;
    }
    return { imported, dropped };
  } finally {
    db.close();
  }
}

/* ---------- dataDir-scanning orchestration ---------- */

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function listDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const SQLITE_SUFFIX = ".sqlite";
const DO_ID_RE = /^[0-9a-f]+\.sqlite$/;

/** The central-mode bindings a `to-central` migration targets, by name. */
export interface CentralMigrationTarget {
  /** Coordination KV — required whenever `durableObjects` migrates at least
   *  one object, so its pending alarm (if any) can be lifted. */
  readonly kv: DenoKvLike;
  /** D1 binding name -> an injected libSQL client for that binding. */
  readonly d1?: Readonly<Record<string, LibsqlClientLike>>;
  /** R2 bucket name -> an injected S3-compatible client + endpoint. */
  readonly r2?: Readonly<Record<string, CentralR2Target>>;
  /** DO class name -> a factory opening (or returning the cached) embedded-
   *  replica client for an object id. */
  readonly durableObjects?: Readonly<
    Record<string, (idHex: string) => SyncSqliteDatabaseLike>
  >;
}

export interface DoClassMigrationReport {
  readonly objects: number;
  readonly alarmsLifted: number;
}

/** The combined report from a `dataDir`-scanning migration run. */
export interface MigrationReport {
  readonly d1: Readonly<Record<string, D1MigrationReport>>;
  readonly r2: Readonly<Record<string, R2MigrationReport>>;
  readonly durableObjects: Readonly<Record<string, DoClassMigrationReport>>;
  /** `dataDir` entries found on disk with no matching target binding —
   *  migrated by nobody, surfaced rather than silently dropped. */
  readonly skipped: readonly string[];
}

/**
 * Scan `dataDir` the way `bindings.ts` laid it out and migrate every
 * binding `target` declares a client for (local mode → central mode) — the
 * common "scale out" direction. A `dataDir` entry with no matching `target`
 * binding is left alone and reported in `skipped`, never migrated partially
 * or silently dropped.
 */
export async function migrateLocalToCentral(
  dataDir: string,
  target: CentralMigrationTarget,
  logger: Logger = noopLogger,
): Promise<MigrationReport> {
  const skipped: string[] = [];

  const d1: Record<string, D1MigrationReport> = {};
  for (const file of listDir(join(dataDir, "d1"))) {
    if (!file.endsWith(SQLITE_SUFFIX)) continue;
    const name = file.slice(0, -SQLITE_SUFFIX.length);
    const client = target.d1?.[name];
    if (client === undefined) {
      skipped.push(`d1/${file}`);
      continue;
    }
    d1[name] = await migrateD1ToCentral(join(dataDir, "d1", file), client);
    logger.info("migrate.d1", { name, ...d1[name] });
  }

  const r2: Record<string, R2MigrationReport> = {};
  for (const entry of listDirEntries(join(dataDir, "r2"))) {
    if (!entry.isDirectory()) continue;
    const bucket = target.r2?.[entry.name];
    if (bucket === undefined) {
      skipped.push(`r2/${entry.name}`);
      continue;
    }
    r2[entry.name] = await migrateR2ToCentral(
      join(dataDir, "r2", entry.name),
      bucket,
    );
    logger.info("migrate.r2", { name: entry.name, ...r2[entry.name] });
  }

  const durableObjects: Record<string, DoClassMigrationReport> = {};
  for (const entry of listDirEntries(join(dataDir, "do"))) {
    if (!entry.isDirectory()) continue;
    const factory = target.durableObjects?.[entry.name];
    if (factory === undefined) {
      skipped.push(`do/${entry.name}`);
      continue;
    }
    let objects = 0;
    let alarmsLifted = 0;
    const classDir = join(dataDir, "do", entry.name);
    for (const file of listDir(classDir)) {
      if (!DO_ID_RE.test(file)) continue;
      const idHex = file.slice(0, -SQLITE_SUFFIX.length);
      const report = await migrateDoObjectToCentral(
        join(classDir, file),
        factory(idHex),
        target.kv,
        entry.name,
        idHex,
      );
      objects += 1;
      if (report.alarmLifted) alarmsLifted += 1;
    }
    durableObjects[entry.name] = { objects, alarmsLifted };
    logger.info("migrate.do", { className: entry.name, objects, alarmsLifted });
  }

  return { d1, r2, durableObjects, skipped };
}

/** One Durable Object to pull from central mode, by class + id. */
export interface CentralDoSource {
  readonly className: string;
  readonly idHex: string;
  readonly storage: SyncSqliteDatabaseLike;
}

/**
 * What to pull from central mode into `dataDir` (central mode → local mode).
 * Unlike {@link migrateLocalToCentral}, central mode has no directory to
 * discover bindings from, so every binding to migrate is named explicitly.
 */
export interface LocalMigrationTarget {
  /** Coordination KV — required whenever `durableObjects` is non-empty, so
   *  each object's pending alarm (if any) can be lowered back. */
  readonly kv?: DenoKvLike;
  /** D1 binding name -> an injected libSQL client to read from. */
  readonly d1?: Readonly<Record<string, LibsqlClientLike>>;
  /** R2 bucket name -> the injected bucket client + the keys to pull (no
   *  generic `list` — see {@link migrateR2ToLocal}). */
  readonly r2?: Readonly<
    Record<
      string,
      { readonly bucket: CentralR2Target; readonly keys: readonly string[] }
    >
  >;
  /** Durable Objects to pull down, named explicitly. */
  readonly durableObjects?: readonly CentralDoSource[];
}

/**
 * Migrate exactly what `source` names from central mode into `dataDir`,
 * writing the same on-disk layout `bindings.ts`/`@dwk/cf-shims` expect.
 */
export async function migrateCentralToLocal(
  dataDir: string,
  source: LocalMigrationTarget,
  logger: Logger = noopLogger,
): Promise<MigrationReport> {
  const d1: Record<string, D1MigrationReport> = {};
  for (const [name, client] of Object.entries(source.d1 ?? {})) {
    d1[name] = await migrateD1ToLocal(
      client,
      join(dataDir, "d1", `${name}${SQLITE_SUFFIX}`),
    );
    logger.info("migrate.d1", { name, ...d1[name] });
  }

  const r2: Record<string, R2MigrationReport> = {};
  for (const [name, spec] of Object.entries(source.r2 ?? {})) {
    r2[name] = await migrateR2ToLocal(
      spec.bucket,
      join(dataDir, "r2", name),
      spec.keys,
    );
    logger.info("migrate.r2", { name, ...r2[name] });
  }

  const durableObjects: Record<string, DoClassMigrationReport> = {};
  for (const object of source.durableObjects ?? []) {
    if (source.kv === undefined) {
      throw new Error(
        "migrateCentralToLocal: durableObjects requires source.kv (to lower pending alarms)",
      );
    }
    const localPath = join(
      dataDir,
      "do",
      object.className,
      `${object.idHex}${SQLITE_SUFFIX}`,
    );
    const report = await migrateDoObjectToLocal(
      object.storage,
      localPath,
      source.kv,
      object.className,
      object.idHex,
    );
    const current = durableObjects[object.className] ?? {
      objects: 0,
      alarmsLifted: 0,
    };
    durableObjects[object.className] = {
      objects: current.objects + 1,
      alarmsLifted: current.alarmsLifted + (report.alarmLifted ? 1 : 0),
    };
  }
  for (const [className, report] of Object.entries(durableObjects)) {
    logger.info("migrate.do", { className, ...report });
  }

  return { d1, r2, durableObjects, skipped: [] };
}

/* ---------- CLI ---------- */

export type MigrateDirection = "to-central" | "to-local";

export interface MigrateCliArgs {
  readonly direction: MigrateDirection;
  readonly dataDir: string;
  readonly configPath: string;
}

/** Parse `dwk-migrate <to-central|to-local> [config] [--data-dir dir]`. */
export function parseMigrateArgs(argv: readonly string[]): MigrateCliArgs {
  let direction: MigrateDirection | undefined;
  let dataDir: string | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--data-dir" || arg === "-d") {
      i += 1;
      dataDir = argv[i];
    } else if (arg === "to-central" || arg === "to-local") {
      direction ??= arg;
    } else if (!arg.startsWith("-")) {
      configPath ??= arg;
    }
  }
  if (direction === undefined) {
    throw new Error(
      "dwk-migrate: missing direction — usage: dwk-migrate <to-central|to-local> <config> [--data-dir dir]",
    );
  }
  return {
    direction,
    dataDir: dataDir ?? process.env.DWK_DATA_DIR ?? "./data",
    configPath:
      configPath ?? process.env.DWK_MIGRATE_CONFIG ?? "./dwk.migrate.js",
  };
}

/** A migration config module's default export — value or factory, matching
 *  `cli.ts`'s `loadConfig` shape for `dwk-serve`. */
type MigrateConfigExport<T> = T | (() => T | Promise<T>);

async function loadMigrateConfig<T>(configPath: string): Promise<T> {
  const href = pathToFileURL(resolve(configPath)).href;
  const mod = (await import(href)) as { default?: MigrateConfigExport<T> };
  if (mod.default === undefined) {
    throw new Error(
      `${configPath}: expected a default export of a migration target/source (or a function returning one)`,
    );
  }
  return typeof mod.default === "function"
    ? await (mod.default as () => T | Promise<T>)()
    : mod.default;
}

export interface MigrateMainOptions {
  readonly argv?: readonly string[];
  readonly logger?: Logger;
}

/** The `dwk-migrate` bin entry: parse args, load the config module, run. */
export async function main(
  options: MigrateMainOptions = {},
): Promise<MigrationReport> {
  const args = parseMigrateArgs(options.argv ?? process.argv.slice(2));
  const logger = options.logger ?? noopLogger;
  logger.info("migrate.start", {
    direction: args.direction,
    dataDir: args.dataDir,
  });
  const report =
    args.direction === "to-central"
      ? await migrateLocalToCentral(
          args.dataDir,
          await loadMigrateConfig<CentralMigrationTarget>(args.configPath),
          logger,
        )
      : await migrateCentralToLocal(
          args.dataDir,
          await loadMigrateConfig<LocalMigrationTarget>(args.configPath),
          logger,
        );
  logger.info("migrate.done", { direction: args.direction });
  return report;
}
