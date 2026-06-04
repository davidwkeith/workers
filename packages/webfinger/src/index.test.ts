import { describe, it, expect } from "vitest";

import {
  createWebfinger,
  resolveConfig,
  filterLinksByRel,
  buildJrd,
  WebfingerLogEvent,
} from "./index";

describe("@dwk/webfinger public surface", () => {
  it("re-exports the factory and helpers", () => {
    expect(typeof createWebfinger).toBe("function");
    expect(typeof resolveConfig).toBe("function");
    expect(typeof filterLinksByRel).toBe("function");
    expect(typeof buildJrd).toBe("function");
  });

  it("exposes the stable log event vocabulary", () => {
    expect(WebfingerLogEvent.Resolved).toBe("webfinger.resolved");
    expect(WebfingerLogEvent.Rejected).toBe("webfinger.rejected");
  });
});
