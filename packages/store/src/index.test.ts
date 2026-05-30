import { describe, expect, it } from "vitest";

import { createStore } from "./index";

describe("@dwk/store", () => {
  it("exposes createStore", () => {
    expect(typeof createStore).toBe("function");
  });

  it("is not implemented yet", () => {
    expect(() => createStore({} as never, {} as never)).toThrow(
      /not implemented/i,
    );
  });
});
