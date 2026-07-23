/**
 * Venue store for the Micropub `q=geo` extension.
 *
 * Venues are read-only proximity results for the `q=geo` query. The implementation
 * defines a strongly-consistent D1 table for venue records, with indexes to make
 * proximity queries safe and deterministic. Venues are independent from post
 * storage and are queried via a distance calculation from the provided coordinates.
 *
 * @see spec/packages/micropub.md#proposed-locationvenue-qgeo
 */

export interface VenueStoreEnv {
  readonly MICROPUB_DB: D1Database;
}

/** Config passed to {@link createMicropubVenueStore}. */
export interface VenueStoreConfig {
  /** Base URL venue resource links are resolved against, e.g. `https://example.com`. */
  readonly baseUrl: string;
}

/** A venue location with geographic coordinates. */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** A reverse-geocoded location suggestion from a coordinates input. */
export interface GeoSuggestion extends GeoPoint {
  readonly label: string;
}

/** A venue that can be returned from a `q=geo` proximity query. */
export interface Venue extends GeoPoint {
  readonly url: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
}

/** A `q=geo` query request with validated parameters. */
export interface VenueSearchQuery {
  readonly point: GeoPoint;
  readonly radiusMetres: number;
  readonly limit: number;
  readonly offset: number;
}

/** A venue record stored in D1. */
export interface VenueRecord extends Venue {
  readonly id: string;
  readonly updatedAt: number;
}

/**
 * A venue store for the `q=geo` extension. The built-in D1 implementation is
 * strongly consistent; custom implementations may inject their own seam.
 */
export interface MicropubVenueStore {
  init(): Promise<void>;
  searchNearby(query: VenueSearchQuery): Promise<{
    readonly geo?: GeoSuggestion;
    readonly venues: readonly Venue[];
  }>;
}

/** D1 schema for venue records. */
const SCHEMA = `CREATE TABLE IF NOT EXISTS micropub_venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  description TEXT,
  category TEXT,
  updated_at INTEGER NOT NULL
)`;

/** Indexes: lat/lon for proximity filtering, name for optional name-based search. */
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS micropub_venues_latlon ON micropub_venues (latitude, longitude)",
  "CREATE INDEX IF NOT EXISTS micropub_venues_name ON micropub_venues (name)",
];

/** Earth's mean radius in metres, used by the haversine distance formula. */
const EARTH_RADIUS_METRES = 6_371_000;

/** Metres per degree of latitude (and of longitude at the equator). */
const METRES_PER_DEGREE = 111_000;

export class VenueValidationError extends Error {}

/** Haversine distance (metres) between two points on earth's surface. */
function haversineDistance(p1: GeoPoint, p2: GeoPoint): number {
  const dLat = ((p2.latitude - p1.latitude) * Math.PI) / 180;
  const dLon = ((p2.longitude - p1.longitude) * Math.PI) / 180;
  const lat1 = (p1.latitude * Math.PI) / 180;
  const lat2 = (p2.latitude * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METRES * c;
}

/**
 * Build a `GeoSuggestion` from coordinates. This echoes the input coordinates
 * back as the label; it is a placeholder for real reverse-geocoding, which
 * this store does not perform.
 */
function geoSuggestionFrom(point: GeoPoint): GeoSuggestion {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    label: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
  };
}

function venueUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, "")}/venues/${encodeURIComponent(id)}`;
}

// --- Query-parameter parsing (`q=geo&...`) ----------------------------------

const GEO_URI_RE =
  /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;u=(\d+(?:\.\d+)?))?$/;
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const NON_NEGATIVE_DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const NON_NEGATIVE_INTEGER_RE = /^\d+$/;

const DEFAULT_RADIUS_METRES = 1000;
const MAX_RADIUS_METRES = 50_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ALLOWED_GEO_PARAMS = new Set([
  "q",
  "uri",
  "lat",
  "lon",
  "u",
  "limit",
  "offset",
]);

function oneParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new VenueValidationError(`\`${name}\` must not be repeated`);
  }
  return values[0] ?? null;
}

function validateCoordinates(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new VenueValidationError(
      "coordinates must be finite decimal degrees, latitude in [-90, 90] and longitude in [-180, 180]",
    );
  }
}

function parseRadius(raw: string): number {
  if (!NON_NEGATIVE_DECIMAL_RE.test(raw)) {
    throw new VenueValidationError(
      "`u` must be a non-negative decimal number of metres",
    );
  }
  const radius = Number(raw);
  if (radius > MAX_RADIUS_METRES) {
    throw new VenueValidationError(
      `\`u\` must not exceed ${MAX_RADIUS_METRES} metres`,
    );
  }
  return radius;
}

/**
 * Parse and validate a Geo URI in the `geo:lat,lon` or `geo:lat,lon;u=radius`
 * form (RFC 5870, restricted to exactly latitude/longitude and an optional
 * `u` parameter). Altitude and any other parameter are rejected.
 */
function parseGeoUri(uri: string): {
  latitude: number;
  longitude: number;
  radiusMetres?: number;
} {
  const match = GEO_URI_RE.exec(uri);
  if (!match) {
    throw new VenueValidationError(
      `\`uri\` must have the form geo:lat,lon or geo:lat,lon;u=radius, got "${uri}"`,
    );
  }
  const latRaw = match[1] as string;
  const lonRaw = match[2] as string;
  const radiusRaw = match[3];
  const latitude = Number(latRaw);
  const longitude = Number(lonRaw);
  validateCoordinates(latitude, longitude);
  return {
    latitude,
    longitude,
    ...(radiusRaw !== undefined
      ? { radiusMetres: parseRadius(radiusRaw) }
      : {}),
  };
}

/**
 * Parse and validate the full `q=geo` query string into a {@link
 * VenueSearchQuery}: exactly one of `uri` or `lat`+`lon`, an optional `u`
 * radius (metres, default 1000, max 50000), and `limit`/`offset` pagination
 * (default 20, max 100; `offset` requires an explicit `limit`). Throws {@link
 * VenueValidationError} on any malformed, duplicated, unsupported, or
 * out-of-range parameter.
 */
export function parseGeoQuery(params: URLSearchParams): VenueSearchQuery {
  for (const key of params.keys()) {
    if (!ALLOWED_GEO_PARAMS.has(key)) {
      throw new VenueValidationError(
        `unsupported \`q=geo\` query parameter \`${key}\``,
      );
    }
  }
  if (params.getAll("q").length !== 1) {
    throw new VenueValidationError("`q` must be supplied exactly once");
  }

  const uri = oneParam(params, "uri");
  const lat = oneParam(params, "lat");
  const lon = oneParam(params, "lon");
  const u = oneParam(params, "u");

  let point: GeoPoint;
  let radiusMetres: number;

  if (uri !== null) {
    if (lat !== null || lon !== null) {
      throw new VenueValidationError(
        "`uri` cannot be combined with `lat`/`lon`",
      );
    }
    if (u !== null) {
      throw new VenueValidationError(
        "`u` cannot be combined with `uri`; encode the radius in the geo URI's `;u=` component",
      );
    }
    const parsed = parseGeoUri(uri);
    point = { latitude: parsed.latitude, longitude: parsed.longitude };
    radiusMetres = parsed.radiusMetres ?? DEFAULT_RADIUS_METRES;
  } else {
    if (lat === null || lon === null) {
      throw new VenueValidationError(
        "`q=geo` requires either `uri` or both `lat` and `lon`",
      );
    }
    if (!DECIMAL_RE.test(lat) || !DECIMAL_RE.test(lon)) {
      throw new VenueValidationError("`lat` and `lon` must be decimal degrees");
    }
    const latitude = Number(lat);
    const longitude = Number(lon);
    validateCoordinates(latitude, longitude);
    point = { latitude, longitude };
    radiusMetres = u === null ? DEFAULT_RADIUS_METRES : parseRadius(u);
  }

  const limitRaw = oneParam(params, "limit");
  const offsetRaw = oneParam(params, "offset");
  if (offsetRaw !== null && limitRaw === null) {
    throw new VenueValidationError("`offset` requires an explicit `limit`");
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!NON_NEGATIVE_INTEGER_RE.test(limitRaw) || Number(limitRaw) < 1) {
      throw new VenueValidationError(
        "`limit` must be a positive base-10 integer",
      );
    }
    limit = Math.min(Number(limitRaw), MAX_LIMIT);
  }

  let offset = 0;
  if (offsetRaw !== null) {
    if (
      !NON_NEGATIVE_INTEGER_RE.test(offsetRaw) ||
      !Number.isSafeInteger(Number(offsetRaw))
    ) {
      throw new VenueValidationError(
        "`offset` must be a non-negative base-10 integer",
      );
    }
    offset = Number(offsetRaw);
  }

  return { point, radiusMetres, limit, offset };
}

// --- Wire views --------------------------------------------------------------

/** Render a {@link GeoSuggestion} in the `q=geo` JSON response shape. */
export function geoSuggestionView(
  suggestion: GeoSuggestion,
): Record<string, unknown> {
  return {
    label: suggestion.label,
    latitude: suggestion.latitude.toString(),
    longitude: suggestion.longitude.toString(),
  };
}

/** Render a {@link Venue} in the `q=geo` JSON response shape. */
export function venueView(venue: Venue): Record<string, unknown> {
  return {
    name: venue.name,
    latitude: venue.latitude.toString(),
    longitude: venue.longitude.toString(),
    url: venue.url,
    ...(venue.description ? { description: venue.description } : {}),
    ...(venue.category ? { category: venue.category } : {}),
  };
}

// --- Store --------------------------------------------------------------------

interface VenueRow {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly description: string | null;
  readonly category: string | null;
  readonly updated_at: number;
}

export function createMicropubVenueStore(
  env: VenueStoreEnv,
  config: VenueStoreConfig,
): MicropubVenueStore {
  if (!env.MICROPUB_DB) {
    throw new VenueValidationError(
      "@dwk/micropub: missing required D1 binding `MICROPUB_DB` for venue storage",
    );
  }
  const db = env.MICROPUB_DB;
  const baseUrl = config.baseUrl;
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

  /**
   * Search venues near a point using a lat/lon bounding-box prefilter (widened
   * by `1 / cos(latitude)` in longitude so the box never excludes an in-radius
   * venue) followed by an exact haversine filter. Results are ordered by
   * ascending distance, with the canonical venue URL as a deterministic
   * tie-breaker, then paginated.
   */
  const searchNearby = async (
    query: VenueSearchQuery,
  ): Promise<{
    readonly geo?: GeoSuggestion;
    readonly venues: readonly Venue[];
  }> => {
    await ensureSchema();

    const { point, radiusMetres, limit, offset } = query;

    const latDelta = radiusMetres / METRES_PER_DEGREE;
    const cosLat = Math.cos((point.latitude * Math.PI) / 180);
    const lonDelta =
      radiusMetres / (METRES_PER_DEGREE * Math.max(cosLat, 1e-6));

    const { results } = await db
      .prepare(
        `SELECT id, name, latitude, longitude, description, category, updated_at
         FROM micropub_venues
         WHERE latitude BETWEEN ? AND ?
           AND longitude BETWEEN ? AND ?`,
      )
      .bind(
        point.latitude - latDelta,
        point.latitude + latDelta,
        point.longitude - lonDelta,
        point.longitude + lonDelta,
      )
      .all<VenueRow>();

    const withinRadius = (results ?? [])
      .map((row) => ({ row, distance: haversineDistance(row, point) }))
      .filter(({ distance }) => distance <= radiusMetres)
      .map(({ row, distance }) => ({
        distance,
        venue: {
          url: venueUrl(baseUrl, row.id),
          name: row.name,
          latitude: row.latitude,
          longitude: row.longitude,
          ...(row.description ? { description: row.description } : {}),
          ...(row.category ? { category: row.category } : {}),
        } satisfies Venue,
      }));

    withinRadius.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.venue.url.localeCompare(b.venue.url);
    });

    return {
      geo: geoSuggestionFrom(point),
      venues: withinRadius.slice(offset, offset + limit).map((v) => v.venue),
    };
  };

  return {
    async init() {
      await ensureSchema();
    },
    searchNearby,
  };
}
