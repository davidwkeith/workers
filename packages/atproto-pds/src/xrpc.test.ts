import { describe, expect, it } from "vitest";

import {
  errorResponse,
  invalidRequest,
  isValidNsid,
  isValidRecordKey,
  XrpcError,
} from "./xrpc";

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
    expect(isValidNsid("app.bsky")).toBe(true);
  });

  it("validates record keys", () => {
    expect(isValidRecordKey("3jui7kd54zh2y")).toBe(true);
    expect(isValidRecordKey("self")).toBe(true);
    expect(isValidRecordKey(".")).toBe(false);
    expect(isValidRecordKey("has space")).toBe(false);
  });
});
