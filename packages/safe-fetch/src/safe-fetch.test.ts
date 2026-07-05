import { describe, it, expect } from "vitest";
import { assertPublicUrl, isPrivateOrReservedHost, SsrfError } from "./safe-fetch.js";

describe("isPrivateOrReservedHost", () => {
  it("blocks loopback addresses", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("127.255.255.254")).toBe(true);
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
  });

  it("blocks the link-local / cloud metadata range", () => {
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("169.254.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
  });

  it("blocks RFC 1918 private ranges", () => {
    expect(isPrivateOrReservedHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fd12:3456::1]")).toBe(true);
  });

  it("blocks 0.0.0.0, CGNAT, benchmark, multicast and reserved", () => {
    expect(isPrivateOrReservedHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("255.255.255.255")).toBe(true);
  });

  it("blocks the IPv4 documentation (TEST-NET) ranges", () => {
    expect(isPrivateOrReservedHost("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.51.100.1")).toBe(true);
    expect(isPrivateOrReservedHost("203.0.113.1")).toBe(true);
  });

  it("blocks IPv6 addresses that embed a private IPv4", () => {
    expect(isPrivateOrReservedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:8.8.8.8]")).toBe(false);
    expect(isPrivateOrReservedHost("[::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::169.254.169.254]")).toBe(true);
  });

  it("blocks site-local, multicast, and documentation IPv6", () => {
    expect(isPrivateOrReservedHost("[fec0::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[ff02::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[2001:db8::1]")).toBe(true);
  });

  it("blocks non-public hostnames", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("foo.localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("blocks names with a trailing dot (FQDN form)", () => {
    expect(isPrivateOrReservedHost("localhost.")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal.")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("example.com.")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700:4700::1111]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("returns the parsed URL for a public http(s) URL by default", () => {
    expect(assertPublicUrl("https://example.com/x").host).toBe("example.com");
    expect(assertPublicUrl("http://example.com/x").host).toBe("example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow(SsrfError);
  });

  it("restricts to allowedSchemes when given", () => {
    expect(() =>
      assertPublicUrl("http://example.com/x", { allowedSchemes: ["https:"] }),
    ).toThrow(SsrfError);
    expect(
      assertPublicUrl("https://example.com/x", { allowedSchemes: ["https:"] })
        .protocol,
    ).toBe("https:");
  });

  it("rejects a private host", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest")).toThrow(
      SsrfError,
    );
    expect(() => assertPublicUrl("http://127.0.0.1:8080/")).toThrow(SsrfError);
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(SsrfError);
  });
});
