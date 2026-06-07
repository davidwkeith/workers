import { describe, it, expect } from "vitest";

import { negotiateFormat } from "./index";

const url = (query = "") =>
  new URL(`https://example.com/.well-known/host-meta${query}`);

describe("negotiateFormat — defaults", () => {
  it("defaults to XRD with no Accept header", () => {
    expect(negotiateFormat(url(), null, false)).toBe("xrd");
  });

  it("defaults to XRD for an empty Accept header", () => {
    expect(negotiateFormat(url(), "", false)).toBe("xrd");
  });

  it("defaults to XRD for a wildcard Accept (no XRD/JRD preference)", () => {
    expect(negotiateFormat(url(), "*/*", false)).toBe("xrd");
  });
});

describe("negotiateFormat — ?format= override", () => {
  it("honours ?format=json", () => {
    expect(
      negotiateFormat(url("?format=json"), "application/xrd+xml", false),
    ).toBe("jrd");
  });

  it("honours ?format=jrd", () => {
    expect(negotiateFormat(url("?format=jrd"), null, false)).toBe("jrd");
  });

  it("honours ?format=xml even on the .json path", () => {
    expect(
      negotiateFormat(url("?format=xml"), "application/jrd+json", true),
    ).toBe("xrd");
  });

  it("honours ?format=xrd over an Accept preference", () => {
    expect(
      negotiateFormat(url("?format=xrd"), "application/jrd+json", false),
    ).toBe("xrd");
  });
});

describe("negotiateFormat — path", () => {
  it("serves JRD for the host-meta.json path", () => {
    expect(negotiateFormat(url(), null, true)).toBe("jrd");
  });
});

describe("negotiateFormat — Accept negotiation", () => {
  it("serves JRD when application/jrd+json is requested", () => {
    expect(negotiateFormat(url(), "application/jrd+json", false)).toBe("jrd");
  });

  it("serves JRD for application/json", () => {
    expect(negotiateFormat(url(), "application/json", false)).toBe("jrd");
  });

  it("serves XRD when application/xrd+xml is requested", () => {
    expect(negotiateFormat(url(), "application/xrd+xml", false)).toBe("xrd");
  });

  it("prefers the higher-q representation (JRD wins)", () => {
    expect(
      negotiateFormat(
        url(),
        "application/xrd+xml;q=0.5, application/jrd+json;q=0.9",
        false,
      ),
    ).toBe("jrd");
  });

  it("prefers the higher-q representation (XRD wins)", () => {
    expect(
      negotiateFormat(
        url(),
        "application/jrd+json;q=0.3, application/xrd+xml;q=0.8",
        false,
      ),
    ).toBe("xrd");
  });

  it("defaults to XRD on a q-value tie", () => {
    expect(
      negotiateFormat(
        url(),
        "application/jrd+json;q=0.7, application/xrd+xml;q=0.7",
        false,
      ),
    ).toBe("xrd");
  });
});
