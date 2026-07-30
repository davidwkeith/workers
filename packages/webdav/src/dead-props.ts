/**
 * Dead-property storage (RFC 4918 §4) over Durable Object SQLite — spec §4.
 *
 * Dead properties are net-new **authoritative** state (a lost property after a
 * MOVE is a correctness bug litmus `propmove` catches), so — like locks — they
 * live in DO SQLite in the same per-pod DO as the write path, never KV. The
 * router ({@link createWebdav}) reads/writes single properties through the
 * `DeadPropertyApi` seam; the tree operations (`copyTree`/`removeTree`) are for
 * the backend adapter to carry properties across COPY/MOVE and drop them on
 * DELETE/overwrite, mirroring where those verbs are implemented.
 *
 * Values are stored as serialized XML fragments (see `serializeFragment`), so
 * text, astral-plane characters, and namespaced child elements (litmus
 * `prophighunicode`, `propvalnspace`) round-trip byte-exactly.
 */

import type { DeadProperty } from "./config.js";

type PropRow = {
  readonly ns: string;
  readonly local: string;
  readonly value_xml: string;
};

/**
 * A namespace URI is never the empty string (`xmlns=""` resolves to *no*
 * namespace, `null`), so `''` is a safe SQLite encoding for the null
 * namespace — a real NULL column would break the composite primary key
 * (SQLite treats NULLs as distinct in UNIQUE constraints).
 */
const NO_NS = "";

function rowToProp(row: PropRow): DeadProperty {
  return {
    ns: row.ns === NO_NS ? null : row.ns,
    local: row.local,
    valueXml: row.value_xml,
  };
}

/** A path's subtree prefix — the path itself when it ends in `/`, else none. */
function subtreePrefix(path: string): string | null {
  return path.endsWith("/") ? path : null;
}

/** Dead-property store, backed by DO SQLite. */
export class PropertyStore {
  readonly #sql: SqlStorage;

  /** @param sql The Durable Object's `state.storage.sql`. */
  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS webdav_dead_props (
         path      TEXT NOT NULL,
         ns        TEXT NOT NULL,
         local     TEXT NOT NULL,
         value_xml TEXT NOT NULL,
         PRIMARY KEY (path, ns, local)
       )`,
    );
  }

  /** Every dead property stored on `path`. */
  list(path: string): DeadProperty[] {
    return this.#sql
      .exec<PropRow>(
        "SELECT ns, local, value_xml FROM webdav_dead_props WHERE path = ? ORDER BY ns, local",
        path,
      )
      .toArray()
      .map(rowToProp);
  }

  /** Create or replace one property (PROPPATCH `<D:set>`). */
  set(path: string, prop: DeadProperty): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO webdav_dead_props (path, ns, local, value_xml) VALUES (?, ?, ?, ?)",
      path,
      prop.ns ?? NO_NS,
      prop.local,
      prop.valueXml,
    );
  }

  /** Delete one property; removing an absent one succeeds (RFC 4918 §9.2). */
  remove(path: string, ns: string | null, local: string): void {
    this.#sql.exec(
      "DELETE FROM webdav_dead_props WHERE path = ? AND ns = ? AND local = ?",
      path,
      ns ?? NO_NS,
      local,
    );
  }

  /**
   * Carry properties across COPY/MOVE (RFC 4918 §9.8.2/§9.9.1, litmus
   * `propmove`): copy `from`'s rows to `to`, plus — when `from` is a collection
   * path and `deep` — every descendant's rows with the prefix rewritten.
   * Destination rows are replaced, but the caller is responsible for clearing
   * a *stale* destination subtree first (`removeTree`) when it overwrites —
   * this only overwrites keys the source also has.
   */
  copyTree(from: string, to: string, deep: boolean): void {
    const copyOne = (src: string, dst: string): void => {
      this.#sql.exec(
        `INSERT OR REPLACE INTO webdav_dead_props (path, ns, local, value_xml)
         SELECT ?, ns, local, value_xml FROM webdav_dead_props WHERE path = ?`,
        dst,
        src,
      );
    };
    copyOne(from, to);
    const prefix = subtreePrefix(from);
    if (prefix === null || !deep) return;
    const descendants = this.#sql
      .exec<{ path: string }>(
        "SELECT DISTINCT path FROM webdav_dead_props WHERE path LIKE ? ESCAPE '\\' AND path != ?",
        `${likeEscape(prefix)}%`,
        from,
      )
      .toArray();
    for (const { path } of descendants) {
      copyOne(path, to + path.slice(prefix.length));
    }
  }

  /**
   * Drop `path`'s properties and, when it is a collection path, its whole
   * subtree's — the DELETE / MOVE-source / overwritten-destination hook.
   */
  removeTree(path: string): void {
    this.#sql.exec("DELETE FROM webdav_dead_props WHERE path = ?", path);
    const prefix = subtreePrefix(path);
    if (prefix !== null) {
      this.#sql.exec(
        "DELETE FROM webdav_dead_props WHERE path LIKE ? ESCAPE '\\'",
        `${likeEscape(prefix)}%`,
      );
    }
  }
}

/** Escape SQL LIKE metacharacters in a literal prefix (`%`, `_`, `\`). */
function likeEscape(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}
