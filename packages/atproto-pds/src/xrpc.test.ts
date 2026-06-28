import { describe, expect, it } from "vitest";

import {
  errorResponse,
  invalidRequest,
  isValidNsid,
  isValidRecordKey,
  XrpcError,
} from "./xrpc.js";

describe("XRPC helpers", () => {
  it("renders an XrpcError as the standard envelope", async () => {
    const res = errorResponse(invalidRequest("bad"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "InvalidRequest",
      message: "bad",
    });
  });

  it("maps unknown errors to 500", async () => {
    const res = errorResponse(new Error("boom"));
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "InternalServerError",
    });
  });

  it("carries status and error name", () => {
    const err = new XrpcError(403, "Forbidden", "nope");
    expect(err.status).toBe(403);
    expect(err.errorName).toBe("Forbidden");
  });

  it("validates NSIDs", () => {
    expect(isValidNsid("app.bsky.feed.post")).toBe(true);
    expect(isValidNsid("com.atproto.repo.createRecord")).toBe(true);
    expect(isValidNsid("nope")).toBe(false);
    // Fewer than three segments is not a valid NSID (authority needs ≥2).
    expect(isValidNsid("app.bsky")).toBe(false);
    // Hyphens are allowed inside authority segments, but not at their edges...
    expect(isValidNsid("com.ex-ample.fooBar")).toBe(true);
    expect(isValidNsid("com.-example.foo")).toBe(false);
    // ...and the final name segment may not contain a hyphen at all.
    expect(isValidNsid("com.example.foo-bar")).toBe(false);
    // Every segment must start with a letter (no leading-digit labels).
    expect(isValidNsid("com.4example.foo")).toBe(false);
  });

  it("validates record keys", () => {
    expect(isValidRecordKey("3jui7kd54zh2y")).toBe(true);
    expect(isValidRecordKey("self")).toBe(true);
    expect(isValidRecordKey(".")).toBe(false);
    expect(isValidRecordKey("has space")).toBe(false);
  });
});
