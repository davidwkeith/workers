import { describe, it, expect } from "vitest";
import {
  applyUpdate,
  parseFormBody,
  parseJsonBody,
  parseUpdateOperations,
  sourceView,
} from "./mf2.js";

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

describe("parseJsonBody", () => {
  it("parses ordinary properties", () => {
    const body = parseJsonBody({
      type: ["h-entry"],
      properties: { content: ["hi"] },
    });
    expect(body.mf2.type).toEqual(["h-entry"]);
    expect(body.mf2.properties.content).toEqual(["hi"]);
  });

  it("drops a __proto__ property instead of reassigning the properties map's own prototype", () => {
    const body = parseJsonBody({
      type: ["h-entry"],
      properties: { __proto__: ["evil"], content: ["hi"] },
    });
    expect(Object.getPrototypeOf(body.mf2.properties)).toBe(Object.prototype);
    expect(body.mf2.properties instanceof Array).toBe(false);
    expect(Object.hasOwn(body.mf2.properties, "__proto__")).toBe(false);
    expect(body.mf2.properties.content).toEqual(["hi"]);
  });

  it("drops constructor/prototype properties the same way", () => {
    const body = parseJsonBody({
      type: ["h-entry"],
      properties: { constructor: ["evil"], prototype: ["evil"] },
    });
    expect(Object.hasOwn(body.mf2.properties, "constructor")).toBe(false);
    expect(Object.hasOwn(body.mf2.properties, "prototype")).toBe(false);
  });
});

describe("parseUpdateOperations + applyUpdate", () => {
  const stored = { content: ["hi"] };

  it("applies an ordinary replace/add/delete", () => {
    const ops = parseUpdateOperations({
      replace: { content: ["bye"] },
      add: { category: ["x"] },
    });
    const next = applyUpdate(stored, ops);
    expect(next.content).toEqual(["bye"]);
    expect(next.category).toEqual(["x"]);
  });

  it("drops a __proto__ key in replace instead of reassigning the result map's own prototype", () => {
    const ops = parseUpdateOperations({ replace: { __proto__: ["evil"] } });
    const next = applyUpdate(stored, ops);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(next instanceof Array).toBe(false);
    expect(Object.hasOwn(next, "__proto__")).toBe(false);
  });

  it("drops a __proto__ key in add without throwing", () => {
    const ops = parseUpdateOperations({ add: { __proto__: ["evil"] } });
    expect(() => applyUpdate(stored, ops)).not.toThrow();
    const next = applyUpdate(stored, ops);
    expect(Object.hasOwn(next, "__proto__")).toBe(false);
    expect(next.content).toEqual(["hi"]);
  });

  it("drops a __proto__ key in delete (array and object forms) without throwing", () => {
    expect(() =>
      applyUpdate(stored, parseUpdateOperations({ delete: ["__proto__"] })),
    ).not.toThrow();
    expect(() =>
      applyUpdate(
        stored,
        parseUpdateOperations({ delete: { __proto__: ["x"] } }),
      ),
    ).not.toThrow();
  });
});

describe("sourceView", () => {
  it("projects only the named properties", () => {
    const post = {
      type: ["h-entry"] as const,
      properties: { content: ["hi"], category: ["x"] },
    };
    expect(sourceView(post, ["content"])).toEqual({
      properties: { content: ["hi"] },
    });
  });

  it("ignores a __proto__ filter entry from ?properties[]= instead of touching the projection's own prototype", () => {
    const post = {
      type: ["h-entry"] as const,
      properties: { content: ["hi"] },
    };
    const result = sourceView(post, ["__proto__", "content"]) as {
      properties: Record<string, readonly unknown[]>;
    };
    expect(Object.getPrototypeOf(result.properties)).toBe(Object.prototype);
    expect(Object.hasOwn(result.properties, "__proto__")).toBe(false);
    expect(result.properties.content).toEqual(["hi"]);
  });
});
