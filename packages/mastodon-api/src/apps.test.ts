import { beforeEach, describe, expect, it } from "vitest";

import { createMastodonStore } from "./store.js";
import type { AppResponse } from "./test-harness.js";
import { api, registerApp, resetDb, testEnv } from "./test-harness.js";

describe("POST /api/v1/apps", () => {
  beforeEach(resetDb);

  it("registers from a JSON body and returns one-time credentials", async () => {
    const app = await registerApp();
    expect(app.name).toBe("Tusky");
    expect(app.website).toBe("https://tusky.app");
    expect(app.redirect_uri).toBe("app://oauth-callback");
    expect(app.redirect_uris).toEqual(["app://oauth-callback"]);
    expect(app.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(app.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(app).not.toHaveProperty("vapid_key");
  });

  it("registers from a form-encoded body", async () => {
    const body = new URLSearchParams({
      client_name: "Pixelfed",
      redirect_uris: "pixelfed://confirm",
      scopes: "read",
    });
    const res = await api()(
      new Request("https://owner.example/api/v1/apps", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(res.status).toBe(200);
    const app = (await res.json()) as AppResponse;
    expect(app.name).toBe("Pixelfed");
    expect(app.redirect_uris).toEqual(["pixelfed://confirm"]);
  });

  it("accepts newline-separated and oob redirect URIs", async () => {
    const app = await registerApp({
      redirect_uris: "app://cb\nurn:ietf:wg:oauth:2.0:oob",
    });
    expect(app.redirect_uris).toEqual([
      "app://cb",
      "urn:ietf:wg:oauth:2.0:oob",
    ]);
  });

  it("rejects a missing client_name with the Mastodon error shape", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: "app://cb" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/client_name/);
  });

  it("rejects missing redirect_uris", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "NoRedirect" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("stores the secret hashed, never the plaintext", async () => {
    const app = await registerApp();
    const stored = await createMastodonStore(testEnv).getClient(app.client_id);
    expect(stored).not.toBeNull();
    expect(stored?.clientSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.clientSecret).not.toBe(app.client_secret);
  });
});
