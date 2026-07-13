import { describe, expect, it } from "vitest";
import { EsiTokenizer, type EsiToken } from "./tokenize.js";

function textOf(tokens: EsiToken[]): string {
  return tokens
    .filter((t): t is Extract<EsiToken, { kind: "text" }> => t.kind === "text")
    .map((t) => t.value)
    .join("");
}

describe("EsiTokenizer", () => {
  it("passes plain text through untouched", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push("<html><body>hello world</body></html>"),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "<html><body>hello world</body></html>" },
    ]);
  });

  it("tokenizes a single self-closing esi:include", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push('before<esi:include src="/frag"/>after'),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "before" },
      { kind: "include", src: "/frag" },
      { kind: "text", value: "after" },
    ]);
  });

  it("parses alt/onerror attributes regardless of order", () => {
    const tokenizer = new EsiTokenizer();
    const t1 = tokenizer.push(
      '<esi:include src="/a" alt="/b" onerror="continue"/>',
    );
    expect(t1).toEqual([
      { kind: "include", src: "/a", alt: "/b", onerror: "continue" },
    ]);

    const t2 = new EsiTokenizer().push(
      '<esi:include onerror="continue" src="/a" alt="/b"/>',
    );
    expect(t2).toEqual([
      { kind: "include", src: "/a", alt: "/b", onerror: "continue" },
    ]);

    const t3 = new EsiTokenizer().push('<esi:include alt="/b" src="/a"/>');
    expect(t3).toEqual([{ kind: "include", src: "/a", alt: "/b" }]);
  });

  it("drops esi:comment entirely", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push('x<esi:comment text="note to self"/>y'),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "x" },
      { kind: "text", value: "y" },
    ]);
  });

  it("drops an esi:remove block including nested plain HTML from the text stream", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push(
        "before<esi:remove><div>fallback <b>html</b></div></esi:remove>after",
      ),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "before" },
      { kind: "remove-block" },
      { kind: "text", value: "after" },
    ]);
    // The nested markup never surfaces as its own text token.
    expect(textOf(tokens)).toBe("beforeafter");
  });

  it("drops a self-closing esi:remove", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push("before<esi:remove/>after"),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "before" },
      { kind: "remove-block" },
      { kind: "text", value: "after" },
    ]);
  });

  it("streams-and-discards an esi:remove block larger than the pending-tag buffer cap, across many push() calls, without leaking any of it", () => {
    const tokenizer = new EsiTokenizer();
    const tokens: EsiToken[] = [];
    tokens.push(...tokenizer.push("before<esi:remove>"));
    // Well over MAX_PENDING_BYTES (8 KB), split across many small pushes —
    // none of this should ever surface as a text token.
    for (let i = 0; i < 200; i++) {
      tokens.push(...tokenizer.push("x".repeat(100)));
    }
    tokens.push(...tokenizer.push("</esi:remove>after"));
    tokens.push(...tokenizer.flush());

    expect(tokens).toEqual([
      { kind: "text", value: "before" },
      { kind: "remove-block" },
      { kind: "text", value: "after" },
    ]);
  });

  it("discards an esi:remove block's closing tag split across two push() calls", () => {
    const full = "before<esi:remove>dropped</esi:remove>after";
    for (let cut = 1; cut < full.length - 1; cut++) {
      const t = new EsiTokenizer();
      const tokens = [
        ...t.push(full.slice(0, cut)),
        ...t.push(full.slice(cut)),
        ...t.flush(),
      ];
      expect(textOf(tokens)).toBe("beforeafter");
      expect(tokens).toContainEqual({ kind: "remove-block" });
    }
  });

  it("discards the rest of the stream when an esi:remove block never closes", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push("before<esi:remove>dropped, never closed"),
      ...tokenizer.flush(),
    ];
    // The marker token fires as soon as the block opens; its (never-closed)
    // contents are discarded rather than leaked as literal text at flush.
    expect(tokens).toEqual([
      { kind: "text", value: "before" },
      { kind: "remove-block" },
    ]);
  });

  it("tokenizes a tag split across two push() calls", () => {
    const full = 'before<esi:include src="/frag" alt="/fallback"/>after';
    for (let cut = 1; cut < full.length - 1; cut++) {
      const t = new EsiTokenizer();
      const tokens = [
        ...t.push(full.slice(0, cut)),
        ...t.push(full.slice(cut)),
        ...t.flush(),
      ];
      expect(textOf(tokens)).toBe("beforeafter");
      expect(tokens).toContainEqual({
        kind: "include",
        src: "/frag",
        alt: "/fallback",
      });
    }
  });

  it("degrades unknown/malformed esi markup to literal passthrough", () => {
    const tokenizer = new EsiTokenizer();
    const original = "a<esi:choose>never supported</esi:choose>b";
    const tokens = [...tokenizer.push(original), ...tokenizer.flush()];
    expect(tokens.every((t) => t.kind === "text")).toBe(true);
    expect(textOf(tokens)).toBe(original);
  });

  it("treats an esi:include with no src as malformed literal text", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push('a<esi:include alt="/b"/>c'),
      ...tokenizer.flush(),
    ];
    expect(tokens.every((t) => t.kind === "text")).toBe(true);
    expect(textOf(tokens)).toBe('a<esi:include alt="/b"/>c');
  });

  it("flushes an unterminated tag at end-of-stream as literal text", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = [
      ...tokenizer.push('a<esi:include src="/frag"'),
      ...tokenizer.flush(),
    ];
    expect(tokens).toEqual([
      { kind: "text", value: "a" },
      { kind: "text", value: '<esi:include src="/frag"' },
    ]);
  });

  it("caps the pending-tag buffer and flushes it as literal text instead of buffering unboundedly", () => {
    const tokenizer = new EsiTokenizer();
    const tokens: EsiToken[] = [];
    tokens.push(...tokenizer.push('a<esi:include src="'));
    // Push well over the 8 KB cap of unresolved "still could be a tag" text
    // with no closing '>' in sight.
    tokens.push(...tokenizer.push("x".repeat(9000)));
    tokens.push(...tokenizer.flush());

    const total = textOf(tokens);
    expect(total).toBe("a" + '<esi:include src="' + "x".repeat(9000));
    // Confirms the overflow was flushed mid-stream (before flush()), not
    // held in memory until end-of-stream.
    expect(tokens.some((t) => t.kind === "text" && t.value.length > 100)).toBe(
      true,
    );
  });

  it("passes text with no esi markup at all straight through without buffering", () => {
    const tokenizer = new EsiTokenizer();
    const tokens = tokenizer.push("just some plain text, nothing special");
    expect(tokens).toEqual([
      { kind: "text", value: "just some plain text, nothing special" },
    ]);
  });
});
