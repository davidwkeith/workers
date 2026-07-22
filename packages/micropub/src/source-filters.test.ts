import { describe, expect, it } from "vitest";

import {
  decodeSourceListCursor,
  encodeSourceListCursor,
  hasProposedSourceFilter,
  parseSourceListFilters,
  SourceFilterError,
  MAX_SOURCE_FILTER_VALUES,
} from "./source-filters.js";

describe("proposed q=source filters", () => {
  it("parses composable filters with explicit AND/OR grouping", () => {
    const filters = parseSourceListFilters(
      new URLSearchParams(
        "after=2026-07-21T00%3A00%3A00Z&before=2026-07-23T00%3A00%3A00Z&order=asc&post-type=h-entry&post-type=h-event&post-status=draft&visibility=private&property-exists%5B%5D=content&property-value%5Bcategory%5D=indieweb&property-value%5Bcategory%5D=workers",
      ),
    );
    expect(filters).toMatchObject({
      order: "asc",
      postTypes: ["h-entry", "h-event"],
      postStatuses: ["draft"],
      visibilities: ["private"],
      propertyExists: ["content"],
      propertyValues: [
        { property: "category", values: ["indieweb", "workers"] },
      ],
    });
    expect(filters.after).toBe(1_784_592_000);
    expect(filters.before).toBe(1_784_764_800);
  });

  it.each([
    "order=sideways",
    "after=yesterday",
    "after=2026-07-21T00%3A00%3A00.500Z",
    "property-exists=content",
    "property-exists%5B%5D=content.title",
    "property-value%5B%5D=x",
  ])("rejects invalid filter %s", (query) => {
    expect(() => parseSourceListFilters(new URLSearchParams(query))).toThrow(
      SourceFilterError,
    );
  });

  it("identifies only the proposed filter parameters", () => {
    expect(hasProposedSourceFilter(new URLSearchParams("limit=10"))).toBe(
      false,
    );
    expect(
      hasProposedSourceFilter(new URLSearchParams("property-value[name]=x")),
    ).toBe(true);
  });

  it("caps dynamic filter values before they reach D1", () => {
    const params = new URLSearchParams();
    for (let index = 0; index <= MAX_SOURCE_FILTER_VALUES; index++) {
      params.append("post-type", `h-entry-${index}`);
    }
    expect(() => parseSourceListFilters(params)).toThrow("at most");
  });

  it("binds a cursor to the complete filter query", () => {
    const filters = parseSourceListFilters(
      new URLSearchParams("order=asc&post-status=draft"),
    );
    const cursor = encodeSourceListCursor(
      { createdAt: 123, url: "https://example.com/a" },
      filters,
    );
    expect(decodeSourceListCursor(cursor, filters)).toEqual({
      createdAt: 123,
      url: "https://example.com/a",
    });
    expect(() =>
      decodeSourceListCursor(
        cursor,
        parseSourceListFilters(new URLSearchParams("order=desc")),
      ),
    ).toThrow("does not match");
  });
});
