import { describe, it, expect } from "vitest";

import { buildHostMetaJrd, serializeJrd } from "./index.js";

describe("buildHostMetaJrd", () => {
  it("always includes links", () => {
    const jrd = buildHostMetaJrd({
      links: [
        { rel: "lrdd", template: "https://example.com/wf?resource={uri}" },
      ],
    });
    expect(jrd.links).toHaveLength(1);
    expect(jrd.links[0]?.rel).toBe("lrdd");
  });

  it("omits subject and properties when absent", () => {
    const jrd = buildHostMetaJrd({ links: [] });
    expect("subject" in jrd).toBe(false);
    expect("properties" in jrd).toBe(false);
  });

  it("carries subject and non-empty properties through", () => {
    const jrd = buildHostMetaJrd({
      subject: "https://example.com/",
      properties: { "http://example.com/role": "host" },
      links: [],
    });
    expect(jrd.subject).toBe("https://example.com/");
    expect(jrd.properties).toEqual({ "http://example.com/role": "host" });
  });

  it("drops an empty properties object", () => {
    const jrd = buildHostMetaJrd({ properties: {}, links: [] });
    expect("properties" in jrd).toBe(false);
  });
});

describe("serializeJrd", () => {
  it("produces parseable JSON preserving a null property", () => {
    const body = serializeJrd({
      properties: { "http://example.com/absent": null },
      links: [
        {
          rel: "lrdd",
          type: "application/jrd+json",
          template: "https://example.com/wf?resource={uri}",
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      properties: Record<string, string | null>;
      links: { rel: string; template?: string }[];
    };
    expect(parsed.properties["http://example.com/absent"]).toBeNull();
    expect(parsed.links[0]?.rel).toBe("lrdd");
    expect(parsed.links[0]?.template).toBe(
      "https://example.com/wf?resource={uri}",
    );
  });
});
