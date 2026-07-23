import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createMicropubVenueStore,
  parseVenueSearchParams,
  VenueValidationError,
  type VenueStoreEnv,
} from "./venues.js";

const harness = env as unknown as VenueStoreEnv;

describe("parseVenueSearchParams", () => {
  it("parses a bare Geo URI with the default radius/limit/offset", () => {
    expect(
      parseVenueSearchParams(
        new URLSearchParams("uri=geo:37.786971,-122.399677"),
      ),
    ).toEqual({
      point: { latitude: 37.786971, longitude: -122.399677 },
      radiusMetres: 1000,
      limit: 20,
      offset: 0,
    });
  });

  it("parses a Geo URI with an explicit `;u=` radius", () => {
    expect(
      parseVenueSearchParams(new URLSearchParams("uri=geo:1,2;u=250")),
    ).toMatchObject({ radiusMetres: 250 });
  });

  it("parses discrete `lat`/`lon`/`u`/`limit`/`offset`", () => {
    expect(
      parseVenueSearchParams(
        new URLSearchParams("lat=10&lon=20&u=500&limit=5&offset=15"),
      ),
    ).toEqual({
      point: { latitude: 10, longitude: 20 },
      radiusMetres: 500,
      limit: 5,
      offset: 15,
    });
  });

  it("accepts `u=0` as an exact-match-only radius", () => {
    expect(
      parseVenueSearchParams(new URLSearchParams("lat=0&lon=0&u=0")),
    ).toMatchObject({ radiusMetres: 0 });
  });

  it("rejects combining `uri` with `lat`/`lon`", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("uri=geo:1,2&lat=1")),
    ).toThrow(VenueValidationError);
  });

  it("rejects a standalone `u` alongside `uri`", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("uri=geo:1,2&u=10")),
    ).toThrow(VenueValidationError);
  });

  it("rejects a Geo URI with an altitude component", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("uri=geo:1,2,3")),
    ).toThrow(VenueValidationError);
  });

  it("rejects `lat` without `lon`", () => {
    expect(() => parseVenueSearchParams(new URLSearchParams("lat=1"))).toThrow(
      VenueValidationError,
    );
  });

  it("rejects out-of-range coordinates", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=100&lon=0")),
    ).toThrow(VenueValidationError);
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=0&lon=200")),
    ).toThrow(VenueValidationError);
  });

  it("rejects a radius above the maximum", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=0&lon=0&u=50001")),
    ).toThrow(VenueValidationError);
  });

  it("rejects `offset` without an explicit `limit`", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=0&lon=0&offset=5")),
    ).toThrow(VenueValidationError);
  });

  it("rejects an unsupported query parameter", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=0&lon=0&radius=5")),
    ).toThrow(VenueValidationError);
  });

  it("rejects a repeated parameter", () => {
    expect(() =>
      parseVenueSearchParams(new URLSearchParams("lat=0&lat=1&lon=0")),
    ).toThrow(VenueValidationError);
  });
});

async function insertVenue(
  db: D1Database,
  venue: {
    id: string;
    url: string;
    name: string;
    latitude: number;
    longitude: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO micropub_venues
         (id, url, name, latitude, longitude, description, category, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(venue.id, venue.url, venue.name, venue.latitude, venue.longitude, 1)
    .run();
}

describe("Micropub venue store", () => {
  it("filters by great-circle radius, corrects the longitude prefilter box for latitude, and orders by distance then URL", async () => {
    const store = createMicropubVenueStore(harness);
    await store.init();
    const suffix = crypto.randomUUID();
    const center = { latitude: 60, longitude: 0 };

    // At latitude 60°, a degree of longitude covers only ~55.7km (cos(60°) =
    // 0.5), so a flat lat/lon bounding box (dividing by the same
    // metres-per-degree constant for both axes) would compute a longitude
    // window of 5000/111320 ≈ 0.0449° here — too narrow to include a venue
    // 0.06° away, even though it is well within the 5000m search radius
    // (~3336m). This regression-tests the cos(latitude) correction.
    await insertVenue(harness.MICROPUB_DB, {
      id: `near-${suffix}`,
      url: `https://example.com/venues/near-${suffix}`,
      name: "Near Venue",
      latitude: 60,
      longitude: 0.06,
    });
    await insertVenue(harness.MICROPUB_DB, {
      id: `center-${suffix}`,
      url: `https://example.com/venues/center-${suffix}`,
      name: "Center Venue",
      latitude: 60,
      longitude: 0,
    });
    await insertVenue(harness.MICROPUB_DB, {
      id: `far-${suffix}`,
      url: `https://example.com/venues/far-${suffix}`,
      name: "Far Venue",
      latitude: 60,
      longitude: 5,
    });

    const result = await store.searchNearby({
      point: center,
      radiusMetres: 5000,
      limit: 20,
      offset: 0,
    });

    const ours = result.venues.filter((v) => v.url.includes(suffix));
    expect(ours.map((v) => v.name)).toEqual(["Center Venue", "Near Venue"]);
    expect(result.geo).toMatchObject({
      latitude: 60,
      longitude: 0,
      label: "60.000000, 0.000000",
    });
  });

  it("paginates the distance-ordered result with offset/limit", async () => {
    const store = createMicropubVenueStore(harness);
    await store.init();
    const suffix = crypto.randomUUID();
    const center = { latitude: 10, longitude: 10 };
    for (const [name, lonOffset] of [
      ["A", 0.001],
      ["B", 0.002],
      ["C", 0.003],
    ] as const) {
      await insertVenue(harness.MICROPUB_DB, {
        id: `${name}-${suffix}`,
        url: `https://example.com/venues/${name}-${suffix}`,
        name,
        latitude: 10,
        longitude: 10 + lonOffset,
      });
    }
    const page = await store.searchNearby({
      point: center,
      radiusMetres: 1000,
      limit: 1,
      offset: 1,
    });
    const ours = page.venues.filter((v) => v.url.includes(suffix));
    expect(ours.map((v) => v.name)).toEqual(["B"]);
  });
});
