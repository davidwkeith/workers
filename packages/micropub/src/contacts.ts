/**
 * Private h-card contacts for the proposed Micropub `q=contact` extension.
 *
 * Contacts have their own injected store seam rather than sharing the posts
 * table. The D1 implementation is strongly consistent and stores the source
 * properties unchanged; derived search and sort keys make the bounded
 * autocomplete query safe without assigning meaning to unknown h-card fields.
 *
 * @see spec/packages/micropub.md#proposed-contacts-qcontact
 */

export const INTERNAL_CONTACT_URL = "_internal_url";

export interface ContactRecord {
  readonly id: string;
  readonly properties: Record<string, unknown[]>;
  readonly identityUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactWrite {
  readonly id: string;
  readonly properties: Record<string, unknown[]>;
  readonly identityUrl: string | null;
  readonly sortKey: string;
  readonly searchText: string;
  readonly now: number;
}

export interface ContactListQuery {
  readonly filter?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface MicropubContactStore {
  init(): Promise<void>;
  create(contact: ContactWrite): Promise<"created" | "conflict">;
  get(id: string): Promise<ContactRecord | null>;
  update(contact: ContactWrite): Promise<"updated" | "not_found" | "conflict">;
  delete(id: string): Promise<boolean>;
  list(query: ContactListQuery): Promise<readonly ContactRecord[]>;
}

export interface MicropubContactStoreEnv {
  readonly MICROPUB_DB: D1Database;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS micropub_contacts (
  id TEXT PRIMARY KEY,
  properties TEXT NOT NULL,
  identity_url TEXT UNIQUE,
  sort_key TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS micropub_contacts_order ON micropub_contacts (sort_key, id)",
];

interface ContactRow {
  readonly id: string;
  readonly properties: string;
  readonly identity_url: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToContact(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    properties: JSON.parse(row.properties) as Record<string, unknown[]>,
    identityUrl: row.identity_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMicropubContactStore(
  env: MicropubContactStoreEnv,
): MicropubContactStore {
  if (!env.MICROPUB_DB) {
    throw new Error("@dwk/micropub: missing required D1 binding `MICROPUB_DB`");
  }
  const db = env.MICROPUB_DB;
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(SCHEMA)
      .run()
      .then(async () => {
        await db.batch(INDEXES.map((sql) => db.prepare(sql)));
      })
      .catch((err: unknown) => {
        ready = null;
        throw err;
      });
    return ready;
  };
  const get = async (id: string): Promise<ContactRecord | null> => {
    await ensureSchema();
    const row = await db
      .prepare(
        `SELECT id, properties, identity_url, created_at, updated_at
           FROM micropub_contacts WHERE id = ?`,
      )
      .bind(id)
      .first<ContactRow>();
    return row ? rowToContact(row) : null;
  };

  return {
    async init() {
      await ensureSchema();
    },
    async create(contact) {
      await ensureSchema();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO micropub_contacts
             (id, properties, identity_url, sort_key, search_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          contact.id,
          JSON.stringify(contact.properties),
          contact.identityUrl,
          contact.sortKey,
          contact.searchText,
          contact.now,
          contact.now,
        )
        .run();
      return result.meta.changes > 0 ? "created" : "conflict";
    },
    get,
    async update(contact) {
      await ensureSchema();
      const result = await db
        .prepare(
          `UPDATE OR IGNORE micropub_contacts
              SET properties = ?, identity_url = ?, sort_key = ?, search_text = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .bind(
          JSON.stringify(contact.properties),
          contact.identityUrl,
          contact.sortKey,
          contact.searchText,
          contact.now,
          contact.id,
        )
        .run();
      if (result.meta.changes > 0) return "updated";
      return (await get(contact.id)) === null ? "not_found" : "conflict";
    },
    async delete(id) {
      await ensureSchema();
      const result = await db
        .prepare("DELETE FROM micropub_contacts WHERE id = ?")
        .bind(id)
        .run();
      return result.meta.changes > 0;
    },
    async list({ filter, limit, offset }) {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT id, properties, identity_url, created_at, updated_at
             FROM micropub_contacts
            WHERE ? IS NULL OR instr(search_text, ?) > 0
            ORDER BY sort_key ASC, id ASC
            LIMIT ? OFFSET ?`,
        )
        .bind(filter ?? null, filter ?? "", limit, offset)
        .all<ContactRow>();
      return results.map(rowToContact);
    },
  };
}

function stringsWithin(value: unknown, seen: Set<object>): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.flatMap((child) => stringsWithin(child, seen));
}

function firstNonEmptyString(
  values: readonly unknown[] | undefined,
): string | undefined {
  return values?.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function normalizeContactText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function canonicalContactUrl(
  properties: Readonly<Record<string, readonly unknown[]>>,
): string | null {
  const first = properties.url?.[0];
  if (first === undefined) return null;
  if (typeof first !== "string") {
    throw new ContactValidationError(
      "the first `url` value must be an absolute http or https URL",
    );
  }
  let url: URL;
  try {
    url = new URL(first);
  } catch {
    throw new ContactValidationError(
      "the first `url` value must be an absolute http or https URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ContactValidationError(
      "the first `url` value must be an absolute http or https URL",
    );
  }
  if (url.pathname === "") url.pathname = "/";
  return url.toString();
}

export class ContactValidationError extends Error {}

export function contactWrite(
  id: string,
  properties: Readonly<Record<string, readonly unknown[]>>,
  now: number,
): ContactWrite {
  if (INTERNAL_CONTACT_URL in properties) {
    throw new ContactValidationError(
      `\`${INTERNAL_CONTACT_URL}\` is response metadata and cannot be stored`,
    );
  }
  const copied: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(properties)) {
    if (values.length === 0) {
      throw new ContactValidationError(
        `\`${key}\` must not be an empty property array`,
      );
    }
    copied[key] = [...values];
  }
  const identity = ["name", "nickname", "url", "email"]
    .map((key) => firstNonEmptyString(copied[key]))
    .find((value) => value !== undefined);
  if (identity === undefined) {
    throw new ContactValidationError(
      "a contact needs a non-empty `name`, `nickname`, `url`, or `email` value",
    );
  }
  const identityUrl = canonicalContactUrl(copied);
  const strings = stringsWithin(copied, new Set<object>());
  const sortText =
    firstNonEmptyString(copied.name) ??
    firstNonEmptyString(copied.nickname) ??
    firstNonEmptyString(copied.url) ??
    firstNonEmptyString(copied.email) ??
    id;
  return {
    id,
    properties: copied,
    identityUrl,
    sortKey: normalizeContactText(sortText),
    searchText: strings.map(normalizeContactText).join("\u0000"),
    now,
  };
}

export function contactView(
  record: ContactRecord,
  internalUrl: string,
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(record.properties)) {
    view[key] = values.length === 1 ? values[0] : [...values];
  }
  view[INTERNAL_CONTACT_URL] = internalUrl;
  return view;
}
