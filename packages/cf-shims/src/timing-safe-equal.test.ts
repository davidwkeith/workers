import { describe, expect, it } from "vitest";

import { installTimingSafeEqual } from "./timing-safe-equal.js";

describe("installTimingSafeEqual", () => {
  it("installs a working crypto.subtle.timingSafeEqual", () => {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual?: (
        a: ArrayBuffer | ArrayBufferView,
        b: ArrayBuffer | ArrayBufferView,
      ) => boolean;
    };
    delete subtle.timingSafeEqual;
    installTimingSafeEqual();
    expect(typeof subtle.timingSafeEqual).toBe("function");
  });

  it("returns true for equal inputs", () => {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual: (
        a: ArrayBuffer | ArrayBufferView,
        b: ArrayBuffer | ArrayBufferView,
      ) => boolean;
    };
    delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    installTimingSafeEqual();
    const a = new TextEncoder().encode("same-value");
    const b = new TextEncoder().encode("same-value");
    expect(subtle.timingSafeEqual(a, b)).toBe(true);
  });

  it("returns false for different inputs of the same length", () => {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual: (
        a: ArrayBuffer | ArrayBufferView,
        b: ArrayBuffer | ArrayBufferView,
      ) => boolean;
    };
    delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    installTimingSafeEqual();
    const a = new TextEncoder().encode("aaaaaaaaaa");
    const b = new TextEncoder().encode("aaaaaaaaab");
    expect(subtle.timingSafeEqual(a, b)).toBe(false);
  });

  it("throws on inputs of different lengths", () => {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual: (
        a: ArrayBuffer | ArrayBufferView,
        b: ArrayBuffer | ArrayBufferView,
      ) => boolean;
    };
    delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    installTimingSafeEqual();
    const a = new TextEncoder().encode("short");
    const b = new TextEncoder().encode("longer-value");
    expect(() => subtle.timingSafeEqual(a, b)).toThrow(TypeError);
  });

  it("is idempotent and does not overwrite an existing implementation", () => {
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual?: (
        a: ArrayBuffer | ArrayBufferView,
        b: ArrayBuffer | ArrayBufferView,
      ) => boolean;
    };
    const sentinel = () => "sentinel" as unknown as boolean;
    subtle.timingSafeEqual = sentinel as unknown as (
      a: ArrayBuffer | ArrayBufferView,
      b: ArrayBuffer | ArrayBufferView,
    ) => boolean;
    installTimingSafeEqual();
    expect(subtle.timingSafeEqual).toBe(sentinel);
    delete (subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
  });
});
