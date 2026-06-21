import { describe, it, expect } from "vitest";

import {
  createHostMeta,
  resolveConfig,
  buildDocument,
  lrddTemplate,
  buildHostMetaJrd,
  serializeJrd,
  serializeXrd,
  escapeXml,
  negotiateFormat,
  HostMetaLogEvent,
} from "./index.js";

describe("@dwk/host-meta public surface", () => {
  it("re-exports the factory and helpers", () => {
    expect(typeof createHostMeta).toBe("function");
    expect(typeof resolveConfig).toBe("function");
    expect(typeof buildDocument).toBe("function");
    expect(typeof lrddTemplate).toBe("function");
    expect(typeof buildHostMetaJrd).toBe("function");
    expect(typeof serializeJrd).toBe("function");
    expect(typeof serializeXrd).toBe("function");
    expect(typeof escapeXml).toBe("function");
    expect(typeof negotiateFormat).toBe("function");
  });

  it("exposes the stable log event vocabulary", () => {
    expect(HostMetaLogEvent.Served).toBe("host-meta.served");
    expect(HostMetaLogEvent.Rejected).toBe("host-meta.rejected");
  });
});
