import { describe, expect, it } from "vitest";
import {
  JsonRpcErrorCode,
  McpProtocolError,
  asObjectParams,
  errorResponse,
  isNotification,
  parseRequest,
  successResponse,
} from "./jsonrpc.js";
import type { JsonRpcErrorResponse, JsonRpcRequest } from "./types.js";

describe("parseRequest", () => {
  it("accepts a valid request with an id", () => {
    const parsed = parseRequest({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("accepts a valid notification (no id member)", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect("id" in (parsed as JsonRpcRequest)).toBe(false);
  });

  it("accepts an explicit id: null as a real request, not a notification", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: null,
      method: "ping",
    }) as JsonRpcRequest;
    expect("id" in parsed).toBe(true);
    expect(parsed.id).toBeNull();
  });

  it("passes through object params", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: "a",
      method: "tools/call",
      params: { name: "x" },
    });
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      id: "a",
      method: "tools/call",
      params: { name: "x" },
    });
  });

  it("rejects a non-object body", () => {
    const parsed = parseRequest("not an object") as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(parsed.id).toBeNull();
  });

  it("rejects an array body", () => {
    const parsed = parseRequest([1, 2, 3]) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("rejects a missing/wrong jsonrpc version, echoing a valid id", () => {
    const parsed = parseRequest({
      jsonrpc: "1.0",
      id: 7,
      method: "ping",
    }) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(parsed.id).toBe(7);
  });

  it("rejects a missing method", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: 1,
    }) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("rejects a non-string method", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: 1,
      method: 42,
    }) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("rejects scalar params", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: "nope",
    }) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("rejects a non-string/number/null id", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: { nested: true },
      method: "ping",
    }) as JsonRpcErrorResponse;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(parsed.id).toBeNull();
  });
});

describe("isNotification", () => {
  it("is true when id is absent", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "ping" })).toBe(true);
  });

  it("is false when id is present, including id: null", () => {
    expect(isNotification({ jsonrpc: "2.0", id: null, method: "ping" })).toBe(
      false,
    );
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(
      false,
    );
  });
});

describe("asObjectParams", () => {
  it("passes through a plain object", () => {
    expect(asObjectParams({ a: 1 })).toEqual({ a: 1 });
  });

  it("treats arrays, scalars, null, and undefined as absent", () => {
    expect(asObjectParams([1, 2])).toBeUndefined();
    expect(asObjectParams("x")).toBeUndefined();
    expect(asObjectParams(null)).toBeUndefined();
    expect(asObjectParams(undefined)).toBeUndefined();
  });
});

describe("response builders", () => {
  it("builds a success response", () => {
    expect(successResponse(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("builds an error response, omitting data when absent", () => {
    const response = errorResponse(1, JsonRpcErrorCode.InternalError, "boom");
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: JsonRpcErrorCode.InternalError, message: "boom" },
    });
    expect("data" in response.error).toBe(false);
  });

  it("builds an error response carrying data", () => {
    const response = errorResponse(1, JsonRpcErrorCode.InvalidParams, "bad", {
      field: "name",
    });
    expect(response.error.data).toEqual({ field: "name" });
  });
});

describe("McpProtocolError", () => {
  it("carries a code, message, and optional data", () => {
    const err = new McpProtocolError(
      JsonRpcErrorCode.InsufficientScope,
      "nope",
      { scope: "x" },
    );
    expect(err.code).toBe(JsonRpcErrorCode.InsufficientScope);
    expect(err.message).toBe("nope");
    expect(err.data).toEqual({ scope: "x" });
    expect(err).toBeInstanceOf(Error);
  });
});
