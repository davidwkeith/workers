/**
 * DO-SQLite schema and the quad ↔ row codec that backs {@link Store}.
 *
 * Everything here is synchronous SQLite (`state.storage.sql`): the quad table
 * holds RDF triples, the `resources` table holds one row per resource (the
 * authoritative pointer — kind, ETag, and for blobs the content-addressed R2
 * key), and `orphan_outbox` is a transactional outbox of R2 keys that became
 * unreferenced at write/delete time. The outbox is written in the *same* SQLite
 * transaction as the pointer change, so "pointer dropped ⇒ orphan recorded" can
 * never tear apart.
 */

import type { StoredQuad, StoredTerm } from "@dwk/rdf";

/** Resource kinds tracked by the pointer table. */
export type ResourceKind = "rdf" | "blob";

/** DDL run once per Durable Object to create the storage tables. */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS resources (
     key          TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     etag         TEXT NOT NULL,
     content_type TEXT NOT NULL DEFAULT '',
     blob_key     TEXT,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS quads (
     resource   TEXT NOT NULL,
     s_type     TEXT NOT NULL,
     s_value    TEXT NOT NULL,
     p_value    TEXT NOT NULL,
     o_type     TEXT NOT NULL,
     o_value    TEXT NOT NULL,
     o_datatype TEXT NOT NULL DEFAULT '',
     o_language TEXT NOT NULL DEFAULT '',
     g_type     TEXT NOT NULL,
     g_value    TEXT NOT NULL,
     PRIMARY KEY (resource, s_value, p_value, o_value, o_datatype, o_language, g_value)
   )`,
  // No standalone index on `quads.resource`: it is the leftmost column of the
  // primary key, so `WHERE resource = ?` already uses the PK index.
  // Index used by the unreferenced-blob check in copy-on-write / delete.
  `CREATE INDEX IF NOT EXISTS resources_by_blob ON resources (blob_key)`,
  `CREATE TABLE IF NOT EXISTS orphan_outbox (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     blob_key    TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL
   )`,
];

/** Column tuple a quad maps onto, in `INSERT` order. */
export type QuadRow = readonly [
  resource: string,
  s_type: string,
  s_value: string,
  p_value: string,
  o_type: string,
  o_value: string,
  o_datatype: string,
  o_language: string,
  g_type: string,
  g_value: string,
];

/** Flatten a {@link StoredQuad} into its `quads` row for a given resource. */
export function quadToRow(resource: string, quad: StoredQuad): QuadRow {
  const o = quad.object;
  return [
    resource,
    quad.subject.termType,
    quad.subject.value,
    quad.predicate.value,
    o.termType,
    o.value,
    o.datatype ?? "",
    o.language ?? "",
    quad.graph.termType,
    quad.graph.value,
  ];
}

/** Shape of a `quads` row as read back from SQLite. */
export type QuadRowRecord = {
  readonly s_type: string;
  readonly s_value: string;
  readonly p_value: string;
  readonly o_type: string;
  readonly o_value: string;
  readonly o_datatype: string;
  readonly o_language: string;
  readonly g_type: string;
  readonly g_value: string;
};

/** Rebuild a {@link StoredQuad} from a `quads` row. */
export function rowToQuad(row: QuadRowRecord): StoredQuad {
  const subject = { termType: row.s_type, value: row.s_value } as StoredTerm;
  const predicate: StoredTerm = { termType: "NamedNode", value: row.p_value };
  const graph = { termType: row.g_type, value: row.g_value } as StoredTerm;

  let object: StoredTerm;
  if (row.o_type === "Literal") {
    if (row.o_language !== "") {
      object = {
        termType: "Literal",
        value: row.o_value,
        language: row.o_language,
      };
    } else if (row.o_datatype !== "") {
      object = {
        termType: "Literal",
        value: row.o_value,
        datatype: row.o_datatype,
      };
    } else {
      object = { termType: "Literal", value: row.o_value };
    }
  } else {
    object = { termType: row.o_type, value: row.o_value } as StoredTerm;
  }

  return { subject, predicate, object, graph };
}
