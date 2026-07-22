/**
 * Proposed `q=source` list filters: request parsing, validation, and opaque
 * keyset cursors. This module is pure so the HTTP handler and D1 store share a
 * single, auditable definition of the filtering contract.
 */

export type SourceListOrder = "asc" | "desc";

export interface PropertyValueFilter {
  readonly property: string;
  readonly values: readonly string[];
}

export interface SourceListFilters {
  readonly after?: number;
  readonly before?: number;
  readonly order: SourceListOrder;
  readonly postTypes: readonly string[];
  readonly postStatuses: readonly string[];
  readonly visibilities: readonly string[];
  readonly propertyExists: readonly string[];
  readonly propertyValues: readonly PropertyValueFilter[];
}

export interface SourceListCursor {
  readonly createdAt: number;
  readonly url: string;
}

export class SourceFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFilterError";
  }
}

const PROPOSED_PARAMETER_NAMES = new Set([
  "after",
  "before",
  "order",
  "post-type",
  "post-status",
  "visibility",
  "property-exists",
  "property-exists[]",
  "cursor",
]);
const PROPERTY_VALUE_PREFIX = "property-value[";
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

export function hasProposedSourceFilter(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (
      PROPOSED_PARAMETER_NAMES.has(key) ||
      (key.startsWith(PROPERTY_VALUE_PREFIX) && key.endsWith("]"))
    ) {
      return true;
    }
  }
  return false;
}

function requiredValues(params: URLSearchParams, name: string): string[] {
  const values = params.getAll(name);
  for (const value of values) {
    if (!value) throw new SourceFilterError(`\`${name}\` must not be empty`);
  }
  return [...new Set(values)].sort();
}

function propertyName(value: string, parameter: string): string {
  if (!PROPERTY_NAME.test(value)) {
    throw new SourceFilterError(
      `\`${parameter}\` must name an mf2 property using letters, digits, and hyphens`,
    );
  }
  return value;
}

function parseBoundary(
  value: string | null,
  name: "after" | "before",
): number | undefined {
  if (value === null) return undefined;
  if (!RFC3339_DATE_TIME.test(value)) {
    throw new SourceFilterError(`\`${name}\` must be an RFC 3339 date-time`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new SourceFilterError(`\`${name}\` must be an RFC 3339 date-time`);
  }
  return Math.floor(milliseconds / 1000);
}

export function parseSourceListFilters(
  params: URLSearchParams,
): SourceListFilters {
  const orderRaw = params.get("order") ?? "desc";
  if (orderRaw !== "asc" && orderRaw !== "desc") {
    throw new SourceFilterError("`order` must be `asc` or `desc`");
  }
  const propertyExists = requiredValues(params, "property-exists[]").map(
    (value) => propertyName(value, "property-exists[]"),
  );
  if (params.has("property-exists")) {
    throw new SourceFilterError("use `property-exists[]` for this filter");
  }
  const propertyValueGroups = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (!key.startsWith(PROPERTY_VALUE_PREFIX) || !key.endsWith("]")) continue;
    const property = propertyName(
      key.slice(PROPERTY_VALUE_PREFIX.length, -1),
      key,
    );
    if (!value) throw new SourceFilterError(`\`${key}\` must not be empty`);
    const values = propertyValueGroups.get(property) ?? [];
    values.push(value);
    propertyValueGroups.set(property, values);
  }
  const propertyValues = [...propertyValueGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([property, values]) => ({
      property,
      values: [...new Set(values)].sort(),
    }));
  const after = parseBoundary(params.get("after"), "after");
  const before = parseBoundary(params.get("before"), "before");
  return {
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    order: orderRaw,
    postTypes: requiredValues(params, "post-type"),
    postStatuses: requiredValues(params, "post-status"),
    visibilities: requiredValues(params, "visibility"),
    propertyExists,
    propertyValues,
  };
}

interface EncodedCursor {
  readonly v: 1;
  readonly o: SourceListOrder;
  readonly t: number;
  readonly u: string;
  readonly f: string;
}

export function sourceFilterFingerprint(filters: SourceListFilters): string {
  return JSON.stringify(filters);
}

export function encodeSourceListCursor(
  cursor: SourceListCursor,
  filters: SourceListFilters,
): string {
  const payload: EncodedCursor = {
    v: 1,
    o: filters.order,
    t: cursor.createdAt,
    u: cursor.url,
    f: sourceFilterFingerprint(filters),
  };
  return btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeSourceListCursor(
  raw: string,
  filters: SourceListFilters,
): SourceListCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw new SourceFilterError("`cursor` is invalid");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    (decoded as Partial<EncodedCursor>).v !== 1 ||
    ((decoded as Partial<EncodedCursor>).o !== "asc" &&
      (decoded as Partial<EncodedCursor>).o !== "desc") ||
    !Number.isSafeInteger((decoded as Partial<EncodedCursor>).t) ||
    typeof (decoded as Partial<EncodedCursor>).u !== "string" ||
    typeof (decoded as Partial<EncodedCursor>).f !== "string"
  ) {
    throw new SourceFilterError("`cursor` is invalid");
  }
  const payload = decoded as EncodedCursor;
  if (
    payload.o !== filters.order ||
    payload.f !== sourceFilterFingerprint(filters)
  ) {
    throw new SourceFilterError("`cursor` does not match these filters");
  }
  return { createdAt: payload.t, url: payload.u };
}
