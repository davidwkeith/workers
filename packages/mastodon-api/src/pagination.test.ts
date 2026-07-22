import { describe, expect, it } from "vitest";

import { buildLinkHeader } from "./pagination.js";

describe("buildLinkHeader", () => {
  it("builds next (max_id=last) and prev (min_id=first) links", () => {
    const url = new URL("https://owner.example/api/v1/timelines/home?limit=20");
    const header = buildLinkHeader(url, { firstId: "100", lastId: "1" });
    expect(header).toBe(
      '<https://owner.example/api/v1/timelines/home?limit=20&max_id=1>; rel="next", ' +
        '<https://owner.example/api/v1/timelines/home?limit=20&min_id=100>; rel="prev"',
    );
  });

  it("returns null for an empty page", () => {
    expect(
      buildLinkHeader(
        new URL("https://owner.example/api/v1/timelines/home"),
        {},
      ),
    ).toBeNull();
  });

  it("replaces an existing max_id/min_id rather than duplicating it", () => {
    const url = new URL(
      "https://owner.example/api/v1/timelines/home?max_id=999",
    );
    const header = buildLinkHeader(url, { firstId: "100", lastId: "1" });
    expect(header).toContain("max_id=1>");
    expect(header).not.toContain("max_id=999");
  });
});
