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

/** A venue write for create/update operations. */
export interface VenueWrite extends Omit<VenueRecord, "id" | "updatedAt"> {
  readonly id?: string;
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

/** Haversine distance (metres) between two points on earth's surface. */
function haversineDistance(p1: GeoPoint, p2: GeoPoint): number {
  const R = 6371000; // Earth's radius in metres
  const dLat = ((p2.latitude - p1.latitude) * Math.PI) / 180;
  const dLon = ((p2.longitude - p1.longitude) * Math.PI) / 180;
  const lat1 = (p1.latitude * Math.PI) / 180;
  const lat2 = (p2.latitude * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parse and validate a Geo URI `geo:lat,lon;u=radius` format.
 * Returns normalized coordinates and radius.
 */
export function parseVenueGeoUri(geoUri: string): { latitude: number; longitude: number } {
  const match = geoUri.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;u=(\d+(?:\.\d+)?))?$/);
  if (!match) {
    throw new VenueValidationError(
      `geo URI must have the form geo:lat,lon;u=radius, got "${geoUri}"`
    );
  }
  const [_, latStr, lonStr] = match;
  const latitude = Number(latStr);
  const longitude = Number(lonStr);
  
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new VenueValidationError(
      `geo URI coordinates must be numeric, got "${geoUri}"`
    );
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new VenueValidationError(
      `geo URI coordinates must be in [-90, 90] for latitude, [-180, 180] for longitude, got "${geoUri}"`
    );
  }
  
  return { latitude, longitude };
}

/**
 * Build a `GeoSuggestion` from coordinates. This returns a formatted
 * coordinate pair as a placeholder for reverse-geocoding.
 */
function geosuggestionFrom(lat: number, lon: number): GeoSuggestion {
  return {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    label: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
  };
}

export class VenueValidationError extends Error {}

export function createMicropubVenueStore(
  env: VenueStoreEnv
): MicropubVenueStore {
  if (!env.MICROPUB_DB) {
    throw new VenueValidationError(
      "@dwk/micropub: missing required D1 binding `MICROPUB_DB` for venue storage"
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
  
  /**
   * Search venues near a point using the haversine formula for distance.
   * Results are ordered by ascending distance, with name as tie-breaker.
   * Pagination is applied to the distance-sorted result set.
   */
  const searchNearby = async (query: VenueSearchQuery): Promise<{
    readonly geo?: GeoSuggestion;
    readonly venues: readonly Venue[];
  }> => {
    await ensureSchema();
    
    const { point, radiusMetres, limit, offset } = query;
    
    const rows: {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      description: string | null;
      category: string | null;
      updated_at: number;
    }[] = [];
    
    // Get candidates using lat/lon bounding box
    const boxResult = await db
      .prepare(
        `SELECT id, name, latitude, longitude, description, category, updated_at
         FROM micropub_venues
         WHERE latitude BETWEEN ? AND ?
           AND longitude BETWEEN ? AND ?`
      )
      .bind(
        point.latitude - radiusMetres / 111000,
        point.latitude + radiusMetres / 111000,
        point.longitude - radiusMetres / 111000,
        point.longitude + radiusMetres / 111000
      )
      .all<VenueRecord>();
    
    // Compute exact distances and filter by radius
    for (const venue of boxResult.results ?? []) {
      const distance = haversineDistance(
        { latitude: venue.latitude, longitude: venue.longitude },
        point
      );
      if (distance <= radiusMetres) {
        rows.push({
          ...venue,
          distance: distance,
        } as any);
      }
    }
    
    // Sort by distance ascending, then by name ascending for determinism
    rows.sort((a, b) => {
      const distDiff = (a as any).distance - (b as any).distance;
      if (distDiff !== 0) return distDiff;
      return a.name.localeCompare(b.name);
    });
    
    // Apply pagination
    const paginated = rows.slice(offset, offset + limit);
    
    return {
      geo: geosuggestionFrom(point.latitude, point.longitude),
      venues: paginated.map(
        (v) =>
          ({
            url: `https://example.com/venues/${encodeURIComponent(v.id)}`,
            name: v.name,
            latitude: v.latitude,
            longitude: v.longitude,
            ...(v.description ? { description: v.description } : {}),
            ...(v.category ? { category: v.category } : {}),
          }) as Venue,
      ),
    };
  };
  
  return {
    async init() {
      await ensureSchema();
    },
    searchNearby,
  };
}
