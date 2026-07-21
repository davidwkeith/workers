import { describe, expect, it } from "vitest";

import {
  MAX_JSON_BODY_BYTES,
  readJson,
  wwwAuthenticateChallenge,
} from "./http.js";

const ENDPOINT = "https://as.example/register";

function postJson(body: unknown): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("readJson", () => {
  it("parses a well-formed JSON body", async () => {
    const result = await readJson(postJson({ a: 1, b: "two" }));
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("returns undefined for a malformed JSON body", async () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(await readJson(request)).toBeUndefined();
  });

  it("returns undefined for an absent body", async () => {
    const request = new Request(ENDPOINT, { method: "POST" });
    expect(await readJson(request)).toBeUndefined();
  });

  it("returns undefined for a body over MAX_JSON_BODY_BYTES without buffering it in full", async () => {
    const huge = JSON.stringify({ x: "a".repeat(MAX_JSON_BODY_BYTES + 1) });
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    expect(await readJson(request)).toBeUndefined();
  });

  it("accepts a body right at the byte cap", async () => {
    // Pad a JSON string value so the whole body lands under the cap.
    const overhead = JSON.stringify({ x: "" }).length;
    const value = "a".repeat(MAX_JSON_BODY_BYTES - overhead);
    const body = JSON.stringify({ x: value });
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const result = (await readJson(request)) as { x: string };
    expect(result.x).toHaveLength(value.length);
  });
});

describe("wwwAuthenticateChallenge", () => {
  it("returns Bearer when there is no Authorization header", () => {
    const request = new Request(ENDPOINT, { method: "POST" });
    expect(wwwAuthenticateChallenge(request)).toBe("Bearer");
  });

  it("returns Bearer for a Bearer Authorization header", () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { authorization: "Bearer some-token" },
    });
    expect(wwwAuthenticateChallenge(request)).toBe("Bearer");
  });

  it("returns a Basic realm challenge for a Basic Authorization header", () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(wwwAuthenticateChallenge(request)).toBe('Basic realm="oauth"');
  });

  it("is case-insensitive on the scheme token", () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { authorization: "basic dXNlcjpwYXNz" },
    });
    expect(wwwAuthenticateChallenge(request)).toBe('Basic realm="oauth"');
  });

  it("falls back to Bearer for an unrecognized scheme", () => {
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { authorization: "Digest something" },
    });
    expect(wwwAuthenticateChallenge(request)).toBe("Bearer");
  });
});
