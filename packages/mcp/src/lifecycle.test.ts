import { describe, expect, it } from "vitest";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  buildInitializeResult,
  negotiateProtocolVersion,
} from "./lifecycle.js";

describe("negotiateProtocolVersion", () => {
  it("echoes back a supported requested version", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it("falls back to the latest for an unsupported version", () => {
    expect(negotiateProtocolVersion("2099-01-01")).toBe(
      LATEST_PROTOCOL_VERSION,
    );
  });

  it("falls back to the latest when the requested version is missing or malformed", () => {
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe("buildInitializeResult", () => {
  const config = { serverInfo: { name: "test-server", version: "1.0.0" } };

  it("negotiates the protocol version from params", () => {
    const result = buildInitializeResult(config, {
      protocolVersion: "2025-03-26",
    });
    expect(result.protocolVersion).toBe("2025-03-26");
  });

  it("falls back to the latest when params are absent", () => {
    const result = buildInitializeResult(config, undefined);
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("advertises tools-only capabilities with listChanged: false", () => {
    const result = buildInitializeResult(config, {});
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("echoes serverInfo and omits instructions when not configured", () => {
    const result = buildInitializeResult(config, {});
    expect(result.serverInfo).toEqual(config.serverInfo);
    expect("instructions" in result).toBe(false);
  });

  it("includes instructions when configured", () => {
    const result = buildInitializeResult(
      { ...config, instructions: "Read-only agent." },
      {},
    );
    expect(result.instructions).toBe("Read-only agent.");
  });
});
