/**
 * Venue store and `q=geo` query parsing for the proposed Micropub
 * Location/Venue extension (issue #359 design).
 *
 * Venues are read-only proximity results: a strongly-consistent D1 table
 * independent of post storage, never derived from post `location`
 * properties. Venue create/update/delete stay with the composing
 * application's own venue system; this module only searches.
 *
 * @see spec/packages/micropub.md#locationvenue-qgeo-extension
 */

export interface VenueStoreEnv {
  readonly MICROPUB_DB: D1Database;
}

/** A location with WGS-84 geographic coordinates. */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** A reverse-geocoded location suggestion for a `q=geo` query point. */
export interface GeoSuggestion extends GeoPoint {
  readonly label: string;
}

/** A venue returned from a `q=geo` proximity query. */
export interface Venue extends GeoPoint {
  readonly url: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
}

/** A validated `q=geo` search request. */
export interface VenueSearchQuery {
  readonly point: GeoPoint;
  readonly radiusMetres: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * A venue store for the `q=geo` extension. The built-in D1 implementation is
 * strongly consistent; custom implementations may inject their own seam.
 */
export interface MicropubVenueStore {
  init(): Promise<void>;
  searchNearby(query: VenueSearchQuery): Promise<{
    readonly geo?: GeoSuggestion;
    /** Filtered, distance-then-URL ordered, and already paginated. */
    readonly venues: readonly Venue[];
  }>;
}

export class VenueValidationError extends Error {}

/**
 * D1 schema for venue records. `url` is the venue's own canonical identity —
 * populated by whatever writes venue rows (the composing application's venue
 * system, out of scope for this read-only extension) — never derived from
 * `id` at query time.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS micropub_venues (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  description TEXT,
  category TEXT,
  updated_at INTEGER NOT NULL
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS micropub_venues_latlon ON micropub_venues (latitude, longitude)",
];

const EARTH_RADIUS_METRES = 6371000;
const METRES_PER_LATITUDE_DEGREE = 111320;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two points (haversine formula). */
function haversineDistanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return EARTH_RADIUS_METRES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Degrees of latitude spanned by `metres`; constant everywhere on the globe. */
function metresToLatitudeDegrees(metres: number): number {
  return metres / METRES_PER_LATITUDE_DEGREE;
}

/**
 * Degrees of longitude spanned by `metres` at `latitudeDegrees`. A degree of
 * longitude shrinks by `cos(latitude)` away from the equator, so dividing by
 * a flat constant (as if longitude behaved like latitude) makes the
 * prefilter box *narrower* than the true search radius at higher latitudes
 * and can silently drop in-radius venues before the haversine filter runs.
 * Clamping `cos` away from zero keeps the box finite near the poles.
 */
function metresToLongitudeDegrees(
  metres: number,
  latitudeDegrees: number,
): number {
  const cos = Math.max(Math.cos(toRadians(latitudeDegrees)), 1e-6);
  return metres / (METRES_PER_LATITUDE_DEGREE * cos);
}

interface VenueRow {
  readonly url: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly description: string | null;
  readonly category: string | null;
}

function rowToVenue(row: VenueRow): Venue {
  return {
    url: row.url,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    ...(row.description ? { description: row.description } : {}),
    ...(row.category ? { category: row.category } : {}),
  };
}

/**
 * A reverse-geocoded suggestion for the query point. This first `q=geo`
 * implementation has no real reverse-geocoding service wired in, so it always
 * echoes the input coordinates back as `label` rather than a place name.
 */
function placeholderGeoSuggestion(point: GeoPoint): GeoSuggestion {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    label: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
  };
}

export function createMicropubVenueStore(
  env: VenueStoreEnv,
): MicropubVenueStore {
  if (!env.MICROPUB_DB) {
    throw new VenueValidationError(
      "@dwk/micropub: missing required D1 binding `MICROPUB_DB` for venue storage",
    );
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

  return {
    async init() {
      await ensureSchema();
    },
    /**
     * Prefilter by a lat/lon bounding box (indexed, corrected for longitude
     * convergence), then apply the exact haversine radius, then sort by
     * distance ascending with venue URL as the deterministic tie-breaker, and
     * finally paginate — so concurrent venue changes cannot destabilize a
     * page.
     */
    async searchNearby({ point, radiusMetres, limit, offset }) {
      await ensureSchema();
      const latDelta = metresToLatitudeDegrees(radiusMetres);
      const lonDelta = metresToLongitudeDegrees(radiusMetres, point.latitude);
      const { results } = await db
        .prepare(
          `SELECT url, name, latitude, longitude, description, category
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

      const withinRadius: Array<{ venue: Venue; distance: number }> = [];
      for (const row of results ?? []) {
        const distance = haversineDistanceMetres(point, {
          latitude: row.latitude,
          longitude: row.longitude,
        });
        if (distance <= radiusMetres) {
          withinRadius.push({ venue: rowToVenue(row), distance });
        }
      }
      withinRadius.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.venue.url.localeCompare(b.venue.url);
      });

      return {
        geo: placeholderGeoSuggestion(point),
        venues: withinRadius
          .slice(offset, offset + limit)
          .map((entry) => entry.venue),
      };
    },
  };
}

// --- `q=geo` query parsing ---------------------------------------------------

const MAX_RADIUS_METRES = 50000;
const DEFAULT_RADIUS_METRES = 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** A bare WGS-84 Geo URI (RFC 5870) with only latitude, longitude, and `u`. */
const GEO_URI_PATTERN =
  /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;u=(\d+(?:\.\d+)?))?$/;

function requireAtMostOne(
  params: URLSearchParams,
  name: string,
): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new VenueValidationError(`\`${name}\` must not be repeated`);
  }
  return values[0] ?? null;
}

function parseCoordinate(
  raw: string,
  name: string,
  min: number,
  max: number,
): number {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new VenueValidationError(
      `\`${name}\` must be a decimal number, got "${raw}"`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new VenueValidationError(
      `\`${name}\` must be in [${min}, ${max}], got "${raw}"`,
    );
  }
  return value;
}

function parseRadius(raw: string): number {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new VenueValidationError(
      `\`u\` must be a non-negative decimal number, got "${raw}"`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value > MAX_RADIUS_METRES) {
    throw new VenueValidationError(
      `\`u\` must be at most ${MAX_RADIUS_METRES} metres, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Parse and validate a full `q=geo` query string: exactly one of `uri` or
 * `lat`+`lon`, an optional radius (`u`, or the Geo URI's `;u=`), and optional
 * `limit`/`offset`. Every malformed, duplicated, out-of-range, or unknown
 * parameter is rejected rather than silently widened or ignored — a broadened
 * location search can disclose saved places beyond what a client intended.
 */
export function parseVenueSearchParams(
  params: URLSearchParams,
): VenueSearchQuery {
  const allowed = new Set(["q", "uri", "lat", "lon", "u", "limit", "offset"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new VenueValidationError(
        `unsupported \`q=geo\` query parameter \`${key}\``,
      );
    }
  }

  const uri = requireAtMostOne(params, "uri");
  const lat = requireAtMostOne(params, "lat");
  const lon = requireAtMostOne(params, "lon");
  const u = requireAtMostOne(params, "u");

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
        "`u` cannot be combined with `uri`; encode the radius as `;u=` in the Geo URI",
      );
    }
    const match = GEO_URI_PATTERN.exec(uri);
    if (!match) {
      throw new VenueValidationError(
        "`uri` must be a bare WGS-84 Geo URI: `geo:lat,lon` or `geo:lat,lon;u=metres`",
      );
    }
    // The pattern's first two capture groups are mandatory whenever the
    // overall match succeeds; only the third (`;u=`) is optional.
    const latStr = match[1] as string;
    const lonStr = match[2] as string;
    const uStr = match[3];
    point = {
      latitude: parseCoordinate(latStr, "uri latitude", -90, 90),
      longitude: parseCoordinate(lonStr, "uri longitude", -180, 180),
    };
    radiusMetres =
      uStr === undefined ? DEFAULT_RADIUS_METRES : parseRadius(uStr);
  } else {
    if (lat === null || lon === null) {
      throw new VenueValidationError(
        "`q=geo` requires either `uri` or both `lat` and `lon`",
      );
    }
    point = {
      latitude: parseCoordinate(lat, "lat", -90, 90),
      longitude: parseCoordinate(lon, "lon", -180, 180),
    };
    radiusMetres = u === null ? DEFAULT_RADIUS_METRES : parseRadius(u);
  }

  const limitRaw = requireAtMostOne(params, "limit");
  const offsetRaw = requireAtMostOne(params, "offset");
  if (offsetRaw !== null && limitRaw === null) {
    throw new VenueValidationError(
      "`offset` is accepted only alongside an explicit `limit`",
    );
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
      throw new VenueValidationError(
        `\`limit\` must be a positive base-10 integer, got "${limitRaw}"`,
      );
    }
    limit = Math.min(Number(limitRaw), MAX_LIMIT);
  }

  let offset = 0;
  if (offsetRaw !== null) {
    if (!/^\d+$/.test(offsetRaw) || !Number.isSafeInteger(Number(offsetRaw))) {
      throw new VenueValidationError(
        `\`offset\` must be a non-negative base-10 integer, got "${offsetRaw}"`,
      );
    }
    offset = Number(offsetRaw);
  }

  return { point, radiusMetres, limit, offset };
}
