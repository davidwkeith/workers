import { describe, expect, it } from "vitest";

import { parseTurtle, writeTurtle } from "./index";

describe("@dwk/rdf", () => {
  it("round-trips a simple Turtle document", async () => {
    const ttl =
      "<https://example.com/a> <https://example.com/b> <https://example.com/c> .";

    const quads = parseTurtle(ttl);
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://example.com/a");

    const serialized = await writeTurtle(quads);
    expect(parseTurtle(serialized)).toHaveLength(1);
  });
});
