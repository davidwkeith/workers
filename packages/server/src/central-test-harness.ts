/**
 * Test doubles for the `central`-mode client seams, shared by
 * `central-bindings.test.ts`, `central-mode.test.ts`, and
 * `central.integration.test.ts`.
 *
 * Same posture as `@dwk/deno-host`'s own (unpublished) test harness: these
 * reproduce the documented client behaviors the shims depend on — `batch` as
 * one transaction, `rowsAffected` on writes, S3's header case-folding — not a
 * mock that always succeeds. Not re-exported from the package's public
 * surface; excluded from the published build (see `tsconfig.build.json`).
 */

import { DatabaseSync } from "node:sqlite";
import type {
  LibsqlClientLike,
  LibsqlResultSetLike,
  LibsqlStatementLike,
  LibsqlTransactionMode,
  S3ClientLike,
} from "@dwk/deno-host";

const WRITE_RE = /^\s*(insert|update|delete|replace)\b/i;

/** An async `LibsqlClientLike` over an in-memory `node:sqlite` database. */
export function createFakeLibsqlClient(
  db = new DatabaseSync(":memory:"),
): LibsqlClientLike & { readonly db: DatabaseSync } {
  function executeSync(stmt: LibsqlStatementLike): LibsqlResultSetLike {
    const rows = db.prepare(stmt.sql).all(...stmt.args) as Record<
      string,
      unknown
    >[];
    const first = rows[0];
    const changes = db.prepare("SELECT changes() AS c").get() as {
      c: number;
    };
    return {
      columns: first ? Object.keys(first) : [],
      rows,
      rowsAffected: WRITE_RE.test(stmt.sql) ? Number(changes.c) : 0,
      lastInsertRowid: undefined,
    };
  }
  return {
    db,
    async execute(stmt) {
      return executeSync(stmt);
    },
    async batch(stmts, mode: LibsqlTransactionMode = "deferred") {
      db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const out = stmts.map(executeSync);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async executeMultiple(sql) {
      db.exec(sql);
    },
  };
}

interface FakeS3Object {
  readonly bytes: Uint8Array;
  readonly headers: Record<string, string>;
}

/**
 * An in-memory `S3ClientLike` reproducing the slice of the S3 REST API
 * `@dwk/deno-host`'s `r2.ts` shim depends on: `PUT`/`GET`/`HEAD`/`DELETE`,
 * header storage, a minted `ETag` per `PUT`, and a `404` for a missing key.
 * `DELETE` is idempotent, matching host-contract §3.4.
 */
export class FakeS3Client implements S3ClientLike {
  readonly #store = new Map<string, FakeS3Object>();

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const path = new URL(input.toString()).pathname;
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "PUT") {
      const bytes = new Uint8Array(
        await new Response(init.body as BodyInit | null).arrayBuffer(),
      );
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      headers["etag"] = crypto.randomUUID();
      this.#store.set(path, { bytes, headers });
      return new Response(null, {
        status: 200,
        headers: { etag: `"${headers["etag"]}"` },
      });
    }

    const object = this.#store.get(path);
    if (method === "DELETE") {
      this.#store.delete(path);
      return new Response(null, { status: 204 });
    }
    if (object === undefined) return new Response(null, { status: 404 });

    const headers = new Headers();
    if (object.headers["content-type"]) {
      headers.set("content-type", object.headers["content-type"]);
    }
    headers.set("content-length", String(object.bytes.byteLength));
    headers.set("etag", `"${object.headers["etag"] ?? "0"}"`);
    headers.set("last-modified", new Date(0).toUTCString());
    for (const [name, value] of Object.entries(object.headers)) {
      if (name.startsWith("x-amz-meta-")) headers.set(name, value);
    }

    if (method === "HEAD") return new Response(null, { status: 200, headers });
    if (method === "GET")
      return new Response(object.bytes, { status: 200, headers });
    throw new Error(`FakeS3Client: unsupported method ${method}`);
  }
}
