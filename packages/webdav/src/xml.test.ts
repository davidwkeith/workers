import { describe, expect, it } from "vitest";
import {
  DAV_NS,
  XmlError,
  childrenNamed,
  escapeXml,
  firstChild,
  parseXml,
  type XmlElement,
} from "./xml.js";

const LIMITS = { maxBytes: 64 * 1024, maxDepth: 32 };

const parse = (xml: string): XmlElement => parseXml(xml, LIMITS);

describe("escapeXml", () => {
  it("escapes the five XML metacharacters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
});

describe("parseXml — namespaces", () => {
  it("resolves a prefixed DAV propfind", () => {
    const root = parse(
      `<?xml version="1.0" encoding="utf-8"?>
       <D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>`,
    );
    expect(root.ns).toBe(DAV_NS);
    expect(root.local).toBe("propfind");
    expect(firstChild(root, DAV_NS, "allprop")).toBeDefined();
  });

  it("resolves a default-namespace document", () => {
    const root = parse(`<propfind xmlns="DAV:"><propname/></propfind>`);
    expect(root.ns).toBe(DAV_NS);
    expect(firstChild(root, DAV_NS, "propname")).toBeDefined();
  });

  it("treats an unprefixed name with no default xmlns as no namespace", () => {
    const root = parse(`<root><child/></root>`);
    expect(root.ns).toBeNull();
    expect(firstChild(root, null, "child")).toBeDefined();
  });

  it("rejects an unbound namespace prefix", () => {
    expect(() => parse(`<D:propfind><D:allprop/></D:propfind>`)).toThrow(
      XmlError,
    );
  });

  it("collects multiple same-named children", () => {
    const root = parse(
      `<D:prop xmlns:D="DAV:"><D:getetag/><D:getcontentlength/></D:prop>`,
    );
    const props = firstChild(
      parse(`<D:propfind xmlns:D="DAV:"></D:propfind>`),
      DAV_NS,
      "prop",
    );
    expect(props).toBeUndefined();
    expect(childrenNamed(root, DAV_NS, "getetag")).toHaveLength(1);
  });
});

describe("parseXml — text and entities", () => {
  it("decodes predefined and numeric entities in text", () => {
    const root = parse(`<owner>a &amp; b &lt; c &#65; &#x42;</owner>`);
    expect(root.text).toBe("a & b < c A B");
  });

  it("reads CDATA verbatim", () => {
    const root = parse(`<owner><![CDATA[a & b < c]]></owner>`);
    expect(root.text).toBe("a & b < c");
  });

  it("rejects an undefined named entity", () => {
    expect(() => parse(`<owner>&bogus;</owner>`)).toThrow(XmlError);
  });

  it("rejects a bare ampersand", () => {
    expect(() => parse(`<owner>a & b</owner>`)).toThrow(XmlError);
  });
});

describe("parseXml — lockinfo", () => {
  it("parses an exclusive write lockinfo with owner href", () => {
    const root = parse(
      `<D:lockinfo xmlns:D="DAV:">
         <D:lockscope><D:exclusive/></D:lockscope>
         <D:locktype><D:write/></D:locktype>
         <D:owner><D:href>mailto:me@dwk.io</D:href></D:owner>
       </D:lockinfo>`,
    );
    const scope = firstChild(root, DAV_NS, "lockscope");
    expect(scope && firstChild(scope, DAV_NS, "exclusive")).toBeDefined();
    const type = firstChild(root, DAV_NS, "locktype");
    expect(type && firstChild(type, DAV_NS, "write")).toBeDefined();
    const owner = firstChild(root, DAV_NS, "owner");
    const href = owner && firstChild(owner, DAV_NS, "href");
    expect(href?.text).toBe("mailto:me@dwk.io");
  });
});

describe("parseXml — XXE and DoS guards", () => {
  it("rejects a DOCTYPE declaration outright (XXE)", () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <propfind xmlns="DAV:">&xxe;</propfind>`;
    expect(() => parse(xml)).toThrow(/DOCTYPE/);
  });

  it("rejects an internal entity declaration", () => {
    expect(() => parse(`<!DOCTYPE r [<!ENTITY e "x">]><r/>`)).toThrow(XmlError);
  });

  it("rejects a body over the size bound with status 400", () => {
    const big = `<r>${"x".repeat(200)}</r>`;
    try {
      parseXml(big, { maxBytes: 32, maxDepth: 8 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XmlError);
      expect((err as XmlError).status).toBe(400);
    }
  });

  it("rejects nesting beyond the depth bound", () => {
    const nested = `<a><b><c><d><e/></d></c></b></a>`;
    expect(() => parseXml(nested, { maxBytes: 1024, maxDepth: 2 })).toThrow(
      XmlError,
    );
  });

  it("rejects a non-UTF-8 encoding declaration with status 415", () => {
    try {
      parse(`<?xml version="1.0" encoding="UTF-16"?><r/>`);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XmlError);
      expect((err as XmlError).status).toBe(415);
    }
  });

  it("accepts an explicit utf-8 declaration", () => {
    expect(parse(`<?xml version="1.0" encoding="utf-8"?><r/>`).local).toBe("r");
  });
});

describe("parseXml — well-formedness", () => {
  it("rejects mismatched end tags", () => {
    expect(() => parse(`<a></b>`)).toThrow(XmlError);
  });

  it("rejects trailing content after the root element", () => {
    expect(() => parse(`<a/><b/>`)).toThrow(XmlError);
  });

  it("rejects duplicate attributes on the same tag (XML 1.0 §3.1)", () => {
    expect(() => parse(`<a x="1" x="2"/>`)).toThrow(/duplicate attribute/);
    // namespace declarations count as attributes too
    expect(() => parse(`<a xmlns:D="DAV:" xmlns:D="urn:other"/>`)).toThrow(
      /duplicate attribute/,
    );
  });

  it("handles self-closing and empty elements", () => {
    const root = parse(
      `<D:propfind xmlns:D="DAV:"><D:propname></D:propname></D:propfind>`,
    );
    expect(firstChild(root, DAV_NS, "propname")).toBeDefined();
  });
});
