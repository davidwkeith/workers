/**
 * Microformats2 (mf2) normalization for Micropub: turning form-encoded and JSON
 * request bodies into the canonical `{ type, properties }` shape, extracting the
 * `mp-*` command properties, applying `update` operations, and projecting the
 * `q=source` view. Pure and protocol-runtime-free — plain data in, plain data
 * out — so it unit-tests without a Workers runtime.
 *
 * @see https://micropub.spec.indieweb.org/#json-syntax
 */

/** A microformats2 object: one or more `h-*` types and their properties. */
export interface Mf2Object {
  /** The vocabulary types, e.g. `["h-entry"]`. */
  readonly type: readonly string[];
  /** Property name → ordered list of values. */
  readonly properties: Readonly<Record<string, readonly unknown[]>>;
}

/** Parsed `mp-*` directives, separated from the stored properties. */
export interface MicropubCommands {
  /** Requested URL slug (`mp-slug`), if any. */
  readonly slug?: string;
  /** Requested syndication targets (`mp-syndicate-to`). */
  readonly syndicateTo: readonly string[];
}

/** An `action: "update"` operation set (JSON only). */
export interface UpdateOperations {
  /** Properties to overwrite wholesale. */
  readonly replace?: Record<string, unknown[]>;
  /** Values to append to each named property. */
  readonly add?: Record<string, unknown[]>;
  /**
   * Properties to remove. A string array removes whole properties; an object
   * removes only the listed values from each named property.
   */
  readonly delete?: string[] | Record<string, unknown[]>;
}

const RESERVED_FORM_KEYS = new Set(["access_token", "action", "url", "h"]);

/**
 * Property/sub-key names that hit an accessor rather than an own-property
 * slot on a plain `obj[key] = ...` assignment: `"__proto__"` reassigns the
 * object's own prototype (or, read via `obj[key] ??= …`, returns the shared
 * `Object.prototype` itself for a further assignment to mutate);
 * `"constructor"`/`"prototype"` are similarly load-bearing. Every place in
 * this module that copies a form field name, a JSON request body's own
 * property names, or a query-string `properties[]` filter value into a
 * plain object checks this set first.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Assign `map[key] = value`, refusing an {@link UNSAFE_KEYS} name instead of
 * writing it. Every place in this module that copies an externally-derived
 * key (a JSON request body's own property names, or query-string `properties[]`
 * filter values) into a plain object literal goes through this, so
 * `"__proto__"` can only ever reach the accessor it names, never create data.
 */
function setOwn<T>(map: Record<string, T>, key: string, value: T): void {
  if (UNSAFE_KEYS.has(key)) return;
  map[key] = value;
}

/**
 * Whether a key is an `mp-*` Micropub command rather than a stored property.
 * Create strips these via {@link extractCommands}; update operands run through
 * the same gate so an update cannot persist a command a create would reject.
 *
 * Only the `mp-*` namespace is stripped — `url`, `name`, etc. are legitimate
 * microformats2 properties that JSON create keeps (the post's canonical
 * identity URL is a separate store column, not the mf2 `url` property), so
 * stripping them would silently drop a valid edit.
 */
function isCommandKey(key: string): boolean {
  return key.startsWith("mp-");
}

/** Drop `mp-*` command keys from a property map (see {@link isCommandKey}). */
function stripCommandKeys(
  map: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(map)) {
    if (!isCommandKey(key)) setOwn(out, key, values);
  }
  return out;
}

/** A `prop[sub]` / `prop[]` / `prop` form key, split into its parts. */
function parseFormKey(rawKey: string): { key: string; sub?: string } {
  const match = /^([^[]+)\[([^\]]*)\]$/.exec(rawKey);
  if (!match) return { key: rawKey };
  const key = match[1] as string;
  const inner = match[2] as string;
  // `prop[]` is just a multi-valued property; only a non-empty `[sub]` nests.
  return inner === "" ? { key } : { key, sub: inner };
}

/** The non-property fields a form/JSON body may carry alongside the mf2 object. */
export interface ParsedBody {
  /** Action verb (`create` when absent). */
  readonly action?: string;
  /** Target URL for `update`/`delete`/`undelete`. */
  readonly url?: string;
  /** Access token carried in the body (form `access_token`). */
  readonly token?: string;
  /** The microformats2 object (present for creates). */
  readonly mf2: Mf2Object;
  /** Parsed `mp-*` commands. */
  readonly commands: MicropubCommands;
}

/** Pull `mp-*` keys out of `properties`, returning the cleaned map + commands. */
function extractCommands(properties: Record<string, unknown[]>): {
  properties: Record<string, unknown[]>;
  commands: MicropubCommands;
} {
  let slug: string | undefined;
  let syndicateTo: string[] = [];
  const cleaned: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(properties)) {
    if (key === "mp-slug") {
      const first = values[0];
      if (typeof first === "string") slug = first;
      continue;
    }
    if (key === "mp-syndicate-to") {
      syndicateTo = values.filter((v): v is string => typeof v === "string");
      continue;
    }
    if (key.startsWith("mp-")) continue; // unknown command: accept and ignore
    setOwn(cleaned, key, values);
  }
  return {
    properties: cleaned,
    commands: { ...(slug !== undefined ? { slug } : {}), syndicateTo },
  };
}

/**
 * Parse a form-encoded body (an iterable of `[key, value]` string pairs) into a
 * {@link ParsedBody}. Repeated keys and `prop[]` accumulate into arrays;
 * `prop[sub]` keys build a nested object value (e.g. `content[html]`).
 */
export function parseFormBody(entries: Iterable<[string, string]>): ParsedBody {
  let action: string | undefined;
  let url: string | undefined;
  let token: string | undefined;
  let h: string | undefined;
  const properties: Record<string, unknown[]> = {};
  const nested: Record<string, Record<string, string>> = {};

  for (const [rawKey, value] of entries) {
    if (rawKey === "access_token") {
      token = value;
      continue;
    }
    if (rawKey === "action") {
      action = value;
      continue;
    }
    if (rawKey === "url") {
      url = value;
      continue;
    }
    if (rawKey === "h") {
      h = value;
      continue;
    }
    const { key, sub } = parseFormKey(rawKey);
    if (RESERVED_FORM_KEYS.has(key)) continue;
    if (UNSAFE_KEYS.has(key) || (sub !== undefined && UNSAFE_KEYS.has(sub))) {
      continue;
    }
    if (sub !== undefined) {
      (nested[key] ??= {})[sub] = value;
    } else {
      (properties[key] ??= []).push(value);
    }
  }
  for (const [key, obj] of Object.entries(nested)) {
    (properties[key] ??= []).push(obj);
  }

  const { properties: cleaned, commands } = extractCommands(properties);
  const type = h ? [`h-${h}`] : [];
  return {
    ...(action !== undefined ? { action } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
    mf2: { type, properties: cleaned },
    commands,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON body into a {@link ParsedBody}. For action requests the mf2
 * object is empty; for creates it is the supplied `{ type, properties }`.
 * Throws {@link Mf2ParseError} on a structurally invalid body.
 */
export function parseJsonBody(body: unknown): ParsedBody {
  if (!isPlainObject(body)) {
    throw new Mf2ParseError("request body must be a JSON object");
  }

  if (typeof body.action === "string") {
    const url = typeof body.url === "string" ? body.url : undefined;
    const token =
      typeof body.access_token === "string" ? body.access_token : undefined;
    return {
      action: body.action,
      ...(url !== undefined ? { url } : {}),
      ...(token !== undefined ? { token } : {}),
      mf2: { type: [], properties: {} },
      commands: { syndicateTo: [] },
    };
  }

  // A create: `type` MUST be an array of strings, `properties` an object of
  // arrays.
  const type = body.type;
  if (!Array.isArray(type) || !type.every((t) => typeof t === "string")) {
    throw new Mf2ParseError("`type` must be an array of strings");
  }
  const rawProps = body.properties;
  if (!isPlainObject(rawProps)) {
    throw new Mf2ParseError("`properties` must be an object");
  }
  const properties: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (!Array.isArray(value)) {
      throw new Mf2ParseError(`property \`${key}\` must be an array`);
    }
    setOwn(properties, key, [...value]);
  }
  const token =
    typeof body.access_token === "string" ? body.access_token : undefined;
  const { properties: cleaned, commands } = extractCommands(properties);
  return {
    ...(token !== undefined ? { token } : {}),
    mf2: { type: type as string[], properties: cleaned },
    commands,
  };
}

/** Parse the `replace`/`add`/`delete` operations of a JSON update request. */
export function parseUpdateOperations(body: unknown): UpdateOperations {
  if (!isPlainObject(body)) {
    throw new Mf2ParseError("update request must be a JSON object");
  }
  const ops: {
    replace?: Record<string, unknown[]>;
    add?: Record<string, unknown[]>;
    delete?: string[] | Record<string, unknown[]>;
  } = {};

  // Strip `mp-*` command keys from every operand, mirroring create: an update
  // must not be able to persist `mp-slug`/`mp-syndicate-to` into stored
  // properties where create rejects them (they would otherwise surface via
  // `q=source`). Real mf2 properties (`url`, `name`, …) pass through unchanged.
  if (body.replace !== undefined) {
    ops.replace = stripCommandKeys(asPropertyMap(body.replace, "replace"));
  }
  if (body.add !== undefined) {
    ops.add = stripCommandKeys(asPropertyMap(body.add, "add"));
  }
  if (body.delete !== undefined) {
    const del = body.delete;
    if (Array.isArray(del)) {
      if (!del.every((k) => typeof k === "string")) {
        throw new Mf2ParseError("`delete` array must contain property names");
      }
      ops.delete = (del as string[]).filter((k) => !isCommandKey(k));
    } else {
      ops.delete = stripCommandKeys(asPropertyMap(del, "delete"));
    }
  }
  return ops;
}

function asPropertyMap(
  value: unknown,
  label: string,
): Record<string, unknown[]> {
  if (!isPlainObject(value)) {
    throw new Mf2ParseError(`\`${label}\` must be an object of arrays`);
  }
  const out: Record<string, unknown[]> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!Array.isArray(val)) {
      throw new Mf2ParseError(`\`${label}.${key}\` must be an array`);
    }
    setOwn(out, key, [...val]);
  }
  return out;
}

/** Thrown when a request body cannot be parsed into a valid mf2 structure. */
export class Mf2ParseError extends Error {}

/**
 * Allowed values for the `post-status` property — the stable Post Status
 * extension. A post is either `published` (the default when the property is
 * absent) or a `draft` that should be omitted from public listings.
 *
 * @see https://indieweb.org/Micropub-extensions#Post_Status
 */
export const POST_STATUS_VALUES = ["published", "draft"] as const;

/**
 * Allowed values for the `visibility` property — the stable Visibility
 * extension. `public` is the default when the property is absent.
 *
 * This endpoint only *stores and advertises* visibility; actually enforcing
 * `unlisted`/`private` at read time is the serving layer's responsibility (a
 * consuming site, or WAC in `@dwk/solid-pod`), not this package's — see
 * `spec/packages/micropub.md`.
 *
 * @see https://indieweb.org/Micropub-extensions#Visibility
 */
export const VISIBILITY_VALUES = [
  "public",
  "unlisted",
  "private",
  "contacts",
] as const;

/**
 * Allowed values for the proposed `location-visibility` property. `text`
 * means the serving layer may disclose a textual place name, but must not
 * disclose coordinates or other precise location data.
 */
export const LOCATION_VISIBILITY_VALUES = [
  "public",
  "private",
  "text",
] as const;

/** Reject a property whose values fall outside an extension's allowed set. */
function assertEnumProperty(
  properties: Readonly<Record<string, readonly unknown[]>>,
  key: string,
  allowed: readonly string[],
): void {
  const values = properties[key];
  if (values === undefined) return;
  for (const value of values) {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new Mf2ParseError(
        `\`${key}\` must be one of ${allowed.map((v) => `\`${v}\``).join(", ")}`,
      );
    }
  }
}

/**
 * Validate the stable-extension vocabulary of a create/update's final property
 * map — `post-status` and `visibility` — throwing {@link Mf2ParseError} on an
 * unrecognised value. An absent property is the extension's documented default
 * (published / public), so it never fails. Enforced on create and on the merged
 * result of an update, so a stored post can only ever carry a known value.
 */
export function validateVocabulary(
  properties: Readonly<Record<string, readonly unknown[]>>,
): void {
  assertEnumProperty(properties, "post-status", POST_STATUS_VALUES);
  assertEnumProperty(properties, "visibility", VISIBILITY_VALUES);
}

/**
 * Validate and normalize the proposed Audience and Location Visibility
 * properties. The upstream proposals reserve the property names but leave
 * their exact data shapes open, so this package adopts a deliberately small
 * interoperable mf2 contract: `audience` is a multi-valued list of configured
 * string IDs, while `location-visibility` is a single string value.
 *
 * The returned map is a copy. Audience IDs are de-duplicated in first-seen
 * order, making a create and an update persist the same canonical shape.
 * Access control and actual location redaction remain the serving layer's
 * responsibility; this function only protects the metadata contract.
 */
export function normalizeProposedVocabulary(
  properties: Readonly<Record<string, readonly unknown[]>>,
  audienceIds: ReadonlySet<string>,
): Record<string, unknown[]> {
  const normalized: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(properties)) {
    setOwn(normalized, key, [...values]);
  }

  const audience = properties.audience;
  if (audience !== undefined) {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const value of audience) {
      if (typeof value !== "string" || !audienceIds.has(value)) {
        throw new Mf2ParseError(
          "`audience` values must be configured audience `uid` strings",
        );
      }
      if (!seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
    if (values.length === 0) {
      throw new Mf2ParseError("`audience` must name at least one audience");
    }
    const visibility = properties.visibility;
    if (visibility?.length !== 1 || visibility[0] !== "private") {
      throw new Mf2ParseError(
        "`audience` requires `visibility` to be exactly `private`",
      );
    }
    normalized.audience = values;
  }

  const locationVisibility = properties["location-visibility"];
  if (locationVisibility !== undefined) {
    if (
      locationVisibility.length !== 1 ||
      typeof locationVisibility[0] !== "string" ||
      !LOCATION_VISIBILITY_VALUES.some(
        (value) => value === locationVisibility[0],
      )
    ) {
      throw new Mf2ParseError(
        "`location-visibility` must be exactly one of `public`, `private`, `text`",
      );
    }
    if ((properties.location?.length ?? 0) === 0) {
      throw new Mf2ParseError(
        "`location-visibility` requires a `location` property",
      );
    }
  }

  return normalized;
}

/**
 * Order-independent deep equality, for `delete`-by-value matching. Compares
 * objects by key membership rather than serialized form, so a nested value like
 * `{ html, value }` matches regardless of the property order the client sends.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null) return false;
  if (typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keysA = Object.keys(aObj);
  const keysB = Object.keys(bObj);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => key in bObj && sameValue(aObj[key], bObj[key]));
}

/**
 * Apply update operations to a property map, returning a new map. `replace`
 * overwrites, `add` appends, and `delete` removes whole properties (string
 * array) or specific values (object).
 */
export function applyUpdate(
  properties: Readonly<Record<string, readonly unknown[]>>,
  ops: UpdateOperations,
): Record<string, unknown[]> {
  const next: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(properties)) {
    setOwn(next, key, [...values]);
  }

  if (ops.replace) {
    for (const [key, values] of Object.entries(ops.replace)) {
      if (UNSAFE_KEYS.has(key)) continue;
      next[key] = [...values];
    }
  }
  if (ops.add) {
    for (const [key, values] of Object.entries(ops.add)) {
      if (UNSAFE_KEYS.has(key)) continue;
      next[key] = [...(next[key] ?? []), ...values];
    }
  }
  if (ops.delete) {
    if (Array.isArray(ops.delete)) {
      for (const key of ops.delete) {
        if (!UNSAFE_KEYS.has(key)) delete next[key];
      }
    } else {
      for (const [key, values] of Object.entries(ops.delete)) {
        if (UNSAFE_KEYS.has(key)) continue;
        const remaining = (next[key] ?? []).filter(
          (existing) => !values.some((v) => sameValue(existing, v)),
        );
        if (remaining.length > 0) next[key] = remaining;
        else delete next[key];
      }
    }
  }
  return next;
}

/**
 * Project the `q=source` view of a stored post. With no `properties` filter the
 * whole `{ type, properties }` object is returned; with one, only the named
 * properties are included (under `properties`), per the Micropub spec.
 */
export function sourceView(
  post: Mf2Object,
  filter?: readonly string[],
): Mf2Object | { properties: Record<string, readonly unknown[]> } {
  if (filter && filter.length > 0) {
    const properties: Record<string, readonly unknown[]> = {};
    for (const key of filter) {
      if (UNSAFE_KEYS.has(key)) continue;
      const values = post.properties[key];
      if (values !== undefined) properties[key] = values;
    }
    return { properties };
  }
  return { type: post.type, properties: post.properties };
}

/**
 * Project the `q=source` **list** view: each post through {@link sourceView}
 * with the same `properties[]` filter, wrapped in the `{ items }` envelope
 * of the Micropub post-list extension. Reusing {@link sourceView} guarantees
 * a list item and a single-post `q=source&url=` response share identical
 * projection semantics.
 */
export function sourceListView(
  posts: readonly Mf2Object[],
  filter?: readonly string[],
): { readonly items: readonly ReturnType<typeof sourceView>[] } {
  return { items: posts.map((post) => sourceView(post, filter)) };
}
