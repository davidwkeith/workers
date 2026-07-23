import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createMicropubVenueStore,
  geoSuggestionView,
  parseGeoQuery,
  venueView,
  VenueValidationError,
  type VenueStoreEnv,
} from "./venues.js";

const harness = env as unknown as VenueStoreEnv;

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseGeoQuery", () => {
  it("parses a geo URI with an explicit radius", () => {
    expect(
      parseGeoQuery(params("q=geo&uri=geo:37.786971,-122.399677;u=250")),
    ).toEqual({
      point: { latitude: 37.786971, longitude: -122.399677 },
      radiusMetres: 250,
      limit: 20,
      offset: 0,
    });
  });

  it("parses lat/lon/u form and defaults the radius to 1000m", () => {
    expect(
      parseGeoQuery(params("q=geo&lat=37.786971&lon=-122.399677")),
    ).toEqual({
      point: { latitude: 37.786971, longitude: -122.399677 },
      radiusMetres: 1000,
      limit: 20,
      offset: 0,
    });
  });

  it("accepts u=0 as an exact-match radius", () => {
    expect(parseGeoQuery(params("q=geo&lat=1&lon=2&u=0")).radiusMetres).toBe(0);
  });

  it("rejects combining uri with lat/lon", () => {
    expect(() =>
      parseGeoQuery(params("q=geo&uri=geo:1,2&lat=1&lon=2")),
    ).toThrow(VenueValidationError);
  });

  it("rejects a standalone u alongside uri, even with no ;u= component", () => {
    expect(() => parseGeoQuery(params("q=geo&uri=geo:1,2&u=100"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects lat without lon and vice versa", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&lon=1"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=91&lon=0"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&lat=0&lon=181"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&uri=geo:37,-181"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects empty/non-decimal coordinates", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=&lon=2"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&lat=abc&lon=2"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects a geo URI with altitude or unsupported components", () => {
    expect(() => parseGeoQuery(params("q=geo&uri=geo:1,2,3"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&uri=geo:1,2;crs=wgs84"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects a radius above 50000m but accepts exactly 50000m", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&u=50001"))).toThrow(
      VenueValidationError,
    );
    expect(
      parseGeoQuery(params("q=geo&lat=1&lon=2&u=50000")).radiusMetres,
    ).toBe(50000);
  });

  it("rejects a negative radius", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&u=-1"))).toThrow(
      VenueValidationError,
    );
  });

  it("requires either uri or lat+lon", () => {
    expect(() => parseGeoQuery(params("q=geo"))).toThrow(VenueValidationError);
  });

  it("rejects unsupported and duplicated query parameters", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&foo=bar"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&lat=1&lat=2&lon=3"))).toThrow(
      VenueValidationError,
    );
  });

  it("defaults limit to 20 and caps it at 100", () => {
    expect(parseGeoQuery(params("q=geo&lat=1&lon=2")).limit).toBe(20);
    expect(parseGeoQuery(params("q=geo&lat=1&lon=2&limit=500")).limit).toBe(
      100,
    );
  });

  it("rejects a non-positive or non-decimal limit", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&limit=0"))).toThrow(
      VenueValidationError,
    );
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&limit=abc"))).toThrow(
      VenueValidationError,
    );
  });

  it("accepts offset only alongside an explicit limit", () => {
    expect(() => parseGeoQuery(params("q=geo&lat=1&lon=2&offset=5"))).toThrow(
      VenueValidationError,
    );
    expect(
      parseGeoQuery(params("q=geo&lat=1&lon=2&limit=10&offset=5")).offset,
    ).toBe(5);
  });

  it("rejects a negative or non-decimal offset", () => {
    expect(() =>
      parseGeoQuery(params("q=geo&lat=1&lon=2&limit=10&offset=-1")),
    ).toThrow(VenueValidationError);
  });
});

describe("view serialization", () => {
  it("renders coordinates as decimal strings", () => {
    expect(
      geoSuggestionView({
        latitude: 37.786971,
        longitude: -122.399677,
        label: "37.786971, -122.399677",
      }),
    ).toEqual({
      label: "37.786971, -122.399677",
      latitude: "37.786971",
      longitude: "-122.399677",
    });
    expect(
      venueView({
        url: "https://example.com/venues/a",
        name: "Apothecary",
        latitude: 37.7869,
        longitude: -122.3996,
      }),
    ).toEqual({
      name: "Apothecary",
      latitude: "37.7869",
      longitude: "-122.3996",
      url: "https://example.com/venues/a",
    });
  });
});

describe("Micropub venue store", () => {
  it("fails loudly when the D1 binding is missing", () => {
    expect(() =>
      createMicropubVenueStore({} as VenueStoreEnv, {
        baseUrl: "https://example.com",
      }),
    ).toThrow(VenueValidationError);
  });

  it("filters by radius, orders by distance then url, and paginates", async () => {
    const store = createMicropubVenueStore(harness, {
      baseUrl: "https://example.com",
    });
    await store.init();
    const suffix = crypto.randomUUID();
    const db = harness.MICROPUB_DB;
    // Origin point: 0,0. Near (~1.1km), far (~111km, outside default radius),
    // and a tie (same distance as "near") to exercise the url tie-breaker.
    await db.batch([
      db
        .prepare(
          `INSERT INTO micropub_venues (id, name, latitude, longitude, description, category, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(`near-${suffix}`, "Near", 0.01, 0, 1),
      db
        .prepare(
          `INSERT INTO micropub_venues (id, name, latitude, longitude, description, category, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(`tie-${suffix}`, "Tie", -0.01, 0, 1),
      db
        .prepare(
          `INSERT INTO micropub_venues (id, name, latitude, longitude, description, category, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(`far-${suffix}`, "Far", 1, 0, 1),
    ]);

    const result = await store.searchNearby({
      point: { latitude: 0, longitude: 0 },
      radiusMetres: 2000,
      limit: 10,
      offset: 0,
    });
    expect(result.geo).toEqual({
      latitude: 0,
      longitude: 0,
      label: "0.000000, 0.000000",
    });
    const ids = result.venues
      .map((v) => decodeURIComponent(v.url.split("/").pop() as string))
      .filter((id) => id.endsWith(suffix));
    // "near" and "tie" are equidistant (~1.11km); "far" (~111km) is outside
    // the 2000m radius. Tie-break is by canonical url ascending.
    const expectedOrder = [`near-${suffix}`, `tie-${suffix}`].sort((a, b) =>
      `https://example.com/venues/${encodeURIComponent(a)}`.localeCompare(
        `https://example.com/venues/${encodeURIComponent(b)}`,
      ),
    );
    expect(ids).toEqual(expectedOrder);

    const paginated = await store.searchNearby({
      point: { latitude: 0, longitude: 0 },
      radiusMetres: 2000,
      limit: 1,
      offset: 1,
    });
    const pageIds = paginated.venues
      .map((v) => decodeURIComponent(v.url.split("/").pop() as string))
      .filter((id) => id.endsWith(suffix));
    expect(pageIds).toEqual([expectedOrder[1]]);
  });

  it("widens the longitude prefilter at high latitude so it doesn't exclude in-radius venues", async () => {
    const store = createMicropubVenueStore(harness, {
      baseUrl: "https://example.com",
    });
    await store.init();
    const suffix = crypto.randomUUID();
    const db = harness.MICROPUB_DB;
    // At latitude 80°, 1 degree of longitude is only ~19km, not ~111km — a
    // longitude window computed without the cos(latitude) correction would
    // be far too narrow and could exclude this venue, which is ~9.6km east
    // at latitude 80 (well within the 20km search radius).
    await db
      .prepare(
        `INSERT INTO micropub_venues (id, name, latitude, longitude, description, category, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .bind(`polar-${suffix}`, "Polar", 80, 0.5, 1)
      .run();

    const result = await store.searchNearby({
      point: { latitude: 80, longitude: 0 },
      radiusMetres: 20_000,
      limit: 10,
      offset: 0,
    });
    const ids = result.venues.map((v) =>
      decodeURIComponent(v.url.split("/").pop() as string),
    );
    expect(ids).toContain(`polar-${suffix}`);
  });
});
