import { beforeEach, describe, expect, it } from "vitest";

import type { MastodonApiConfig } from "./config.js";
import { api, resetDb, testConfig } from "./test-harness.js";

const fullConfig: MastodonApiConfig = {
  ...testConfig,
  instance: {
    title: "Owner's site",
    description: "A personal site",
    contactEmail: "me@owner.example",
    languages: ["en"],
    thumbnail: "https://owner.example/thumb.png",
  },
  softwareVersion: "0.1.0",
};

describe("instance endpoints", () => {
  beforeEach(resetDb);

  it("serves v1 publicly, without a streaming URL", async () => {
    const res = await api(fullConfig)(
      new Request("https://owner.example/api/v1/instance"),
    );
    expect(res.status).toBe(200);
    const v1 = (await res.json()) as Record<string, unknown>;
    expect(v1["uri"]).toBe("owner.example");
    expect(v1["title"]).toBe("Owner's site");
    expect(v1["email"]).toBe("me@owner.example");
    expect(v1["urls"]).toEqual({});
    expect(v1["stats"]).toEqual({
      user_count: 1,
      status_count: 0,
      domain_count: 0,
    });
    expect(v1["registrations"]).toBe(false);
    expect(v1["version"]).toMatch(/^4\.2\.0 \(compatible; dwk-workers\//);
  });

  it("serves v2 publicly with domain and closed registrations", async () => {
    const res = await api(fullConfig)(
      new Request("https://owner.example/api/v2/instance"),
    );
    expect(res.status).toBe(200);
    const v2 = (await res.json()) as Record<string, unknown>;
    expect(v2["domain"]).toBe("owner.example");
    expect(v2["usage"]).toEqual({ users: { active_month: 1 } });
    expect(v2["registrations"]).toEqual({
      enabled: false,
      approval_required: true,
      message: null,
    });
    expect(v2["contact"]).toEqual({
      email: "me@owner.example",
      account: null,
    });
    expect(v2["rules"]).toEqual([]);
  });
});
