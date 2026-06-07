import { describe, expect, it } from "vitest";

import {
  ALLOWED_METHODS,
  corsHeaders,
  preflightResponse,
  withCors,
} from "./cors";

describe("corsHeaders", () => {
  it("echoes a concrete Origin and varies on it", () => {
    const headers = corsHeaders("https://app.example");
    expect(headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(headers["vary"]).toBe("Origin");
    expect(headers["access-control-expose-headers"]).toContain("ETag");
  });

  it("falls back to * when no Origin is present", () => {
    expect(corsHeaders(null)["access-control-allow-origin"]).toBe("*");
  });
});

describe("preflightResponse", () => {
  it("answers 204 with the allowed methods and headers", () => {
    const response = preflightResponse("https://app.example");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      ALLOWED_METHODS,
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
    expect(response.headers.get("access-control-max-age")).toBeTruthy();
  });
});

describe("withCors", () => {
  it("merges CORS headers onto an existing response, preserving body and status", async () => {
    const original = new Response("hello", {
      status: 201,
      headers: { etag: '"abc"' },
    });
    const wrapped = withCors(original, "https://app.example");
    expect(wrapped.status).toBe(201);
    expect(await wrapped.text()).toBe("hello");
    expect(wrapped.headers.get("etag")).toBe('"abc"');
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
  });
});
