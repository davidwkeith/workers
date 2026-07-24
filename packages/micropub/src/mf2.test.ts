import { describe, it, expect } from "vitest";
import { parseFormBody } from "./mf2.js";

describe("parseFormBody", () => {
  it("parses ordinary properties, multi-valued and nested", () => {
    const body = parseFormBody(
      new URLSearchParams([
        ["h", "entry"],
        ["content[html]", "<p>hi</p>"],
        ["category[]", "a"],
        ["category[]", "b"],
      ]),
    );
    expect(body.mf2.properties.content).toEqual([{ html: "<p>hi</p>" }]);
    expect(body.mf2.properties.category).toEqual(["a", "b"]);
  });

  it("drops a __proto__ key instead of polluting Object.prototype", () => {
    const before = ({} as Record<string, unknown>).polluted;
    parseFormBody(new URLSearchParams([["__proto__[polluted]", "pwned"]]));
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops a top-level __proto__/constructor/prototype key", () => {
    const body = parseFormBody(
      new URLSearchParams([
        ["__proto__", "x"],
        ["constructor", "y"],
        ["prototype", "z"],
        ["content", "kept"],
      ]),
    );
    expect(Object.hasOwn(body.mf2.properties, "__proto__")).toBe(false);
    expect(Object.hasOwn(body.mf2.properties, "constructor")).toBe(false);
    expect(Object.hasOwn(body.mf2.properties, "prototype")).toBe(false);
    expect(body.mf2.properties.content).toEqual(["kept"]);
  });

  it("drops a __proto__/constructor/prototype sub-key without dropping the parent property", () => {
    const body = parseFormBody(
      new URLSearchParams([["content[__proto__]", "pwned"]]),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(body.mf2.properties.content).toBeUndefined();
  });
});
