import { beforeEach, describe, expect, it } from "vitest";

import { STUB_ROUTES } from "./stubs.js";
import { api, obtainAccessToken, resetDb } from "./test-harness.js";

describe("stub roster", () => {
  beforeEach(resetDb);

  it("answers every stub path 200 with its exact body for a valid token", async () => {
    const token = await obtainAccessToken();
    for (const stub of STUB_ROUTES) {
      const res = await api()(
        new Request(`https://owner.example${stub.path}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status, stub.path).toBe(200);
      expect(await res.json(), stub.path).toEqual(stub.body);
    }
  });

  it("serves custom_emojis without a token", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/custom_emojis"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("401s authed stub paths without a token", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/favourites"),
    );
    expect(res.status).toBe(401);
  });

  it("keeps push subscription a 404 (explicit non-goal)", async () => {
    const token = await obtainAccessToken();
    const res = await api()(
      new Request("https://owner.example/api/v1/push/subscription", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("covers the full roster from the design", () => {
    expect(STUB_ROUTES.map((stub) => stub.path).sort()).toEqual(
      [
        "/api/v1/accounts/relationships",
        "/api/v1/filters",
        "/api/v2/filters",
        "/api/v1/lists",
        "/api/v1/custom_emojis",
        "/api/v1/announcements",
        "/api/v1/conversations",
        "/api/v1/favourites",
        "/api/v1/bookmarks",
        "/api/v1/preferences",
      ].sort(),
    );
  });
});
