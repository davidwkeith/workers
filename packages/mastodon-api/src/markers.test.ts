import { beforeEach, describe, expect, it } from "vitest";

import { api, obtainAccessToken, resetDb } from "./test-harness.js";

function markersGet(token: string, timelines: readonly string[]): Request {
  const url = new URL("https://owner.example/api/v1/markers");
  for (const timeline of timelines) {
    url.searchParams.append("timeline[]", timeline);
  }
  return new Request(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("/api/v1/markers", () => {
  beforeEach(resetDb);

  it("requires an account-bound token", async () => {
    const anonymous = await api()(
      new Request("https://owner.example/api/v1/markers?timeline[]=home"),
    );
    expect(anonymous.status).toBe(401);

    const appToken = await obtainAccessToken("client_credentials");
    const appLevel = await api()(markersGet(appToken, ["home"]));
    expect(appLevel.status).toBe(422);
  });

  it("returns {} before any marker is saved", async () => {
    const token = await obtainAccessToken();
    const res = await api()(markersGet(token, ["home", "notifications"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("saves via form body and reads back with version increments", async () => {
    const token = await obtainAccessToken();
    const save = await api()(
      new Request("https://owner.example/api/v1/markers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ "home[last_read_id]": "101" }),
      }),
    );
    expect(save.status).toBe(200);
    const saved = (await save.json()) as Record<
      string,
      { last_read_id: string; version: number }
    >;
    expect(saved["home"]?.last_read_id).toBe("101");
    expect(saved["home"]?.version).toBe(1);

    const again = await api()(
      new Request("https://owner.example/api/v1/markers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ "home[last_read_id]": "202" }),
      }),
    );
    const bumped = (await again.json()) as Record<
      string,
      { last_read_id: string; version: number }
    >;
    expect(bumped["home"]?.last_read_id).toBe("202");
    expect(bumped["home"]?.version).toBe(2);

    const read = await api()(markersGet(token, ["home", "notifications"]));
    const markers = (await read.json()) as Record<string, unknown>;
    expect(Object.keys(markers)).toEqual(["home"]);
  });

  it("saves via JSON body and leaves the other timeline untouched", async () => {
    const token = await obtainAccessToken();
    const res = await api()(
      new Request("https://owner.example/api/v1/markers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ notifications: { last_read_id: "77" } }),
      }),
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Record<
      string,
      { last_read_id: string }
    >;
    expect(saved["notifications"]?.last_read_id).toBe("77");
    expect(saved).not.toHaveProperty("home");

    const read = await api()(markersGet(token, ["home", "notifications"]));
    const markers = (await read.json()) as Record<string, unknown>;
    expect(Object.keys(markers)).toEqual(["notifications"]);
  });

  it("ignores unknown timeline names", async () => {
    const token = await obtainAccessToken();
    const res = await api()(
      new Request("https://owner.example/api/v1/markers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ favourites: { last_read_id: "9" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
