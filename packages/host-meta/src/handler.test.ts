import { describe, it, expect } from "vitest";

import {
  createHostMeta,
  HostMetaLogEvent,
  type HostMetaConfig,
  type HostMetaEnv,
  type Logger,
  type Metrics,
} from "./index.js";

const env: HostMetaEnv = {};
const ctx = {} as ExecutionContext;

const XRD_BASE = "https://example.com/.well-known/host-meta";
const JSON_BASE = "https://example.com/.well-known/host-meta.json";

function fixture(extra?: Partial<HostMetaConfig>) {
  return createHostMeta({
    webfingerUrl: "https://example.com/.well-known/webfinger",
    links: [{ rel: "author", href: "https://example.com/about" }],
    ...extra,
  });
}

type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: { [k: string]: unknown };
};

function captureLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]) =>
    (event: string, fields?: { [k: string]: unknown }) =>
      records.push({ level, event, fields });
  return {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function captureMetrics(): Metrics & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    count: (event: string) => {
      events.push(event);
    },
    observe: (event: string) => {
      events.push(event);
    },
  };
}

describe("createHostMeta construction", () => {
  it("throws when nothing is configured to advertise", () => {
    expect(() => createHostMeta({})).toThrow(/at least one link/);
  });
});

describe("host-meta handler — default XRD", () => {
  it("serves XRD by default at /.well-known/host-meta", async () => {
    const res = await fixture()(new Request(XRD_BASE), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/xrd+xml; charset=utf-8",
    );
    const body = await res.text();
    expect(body).toContain("<XRD");
    expect(body).toContain('rel="lrdd"');
    expect(body).toContain(
      'template="https://example.com/.well-known/webfinger?resource={uri}"',
    );
  });

  it("advertises permissive CORS and Vary: Accept", async () => {
    const res = await fixture()(new Request(XRD_BASE), env, ctx);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBe("Accept");
  });
});

describe("host-meta handler — JRD", () => {
  it("serves JRD on the .json path", async () => {
    const res = await fixture()(new Request(JSON_BASE), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/jrd+json; charset=utf-8",
    );
    const body = (await res.json()) as { links: { rel: string }[] };
    expect(body.links[0]?.rel).toBe("lrdd");
  });

  it("serves JRD when ?format=json is set on the bare path", async () => {
    const res = await fixture()(
      new Request(`${XRD_BASE}?format=json`),
      env,
      ctx,
    );
    expect(res.headers.get("content-type")).toBe(
      "application/jrd+json; charset=utf-8",
    );
  });

  it("serves JRD when the Accept header prefers it", async () => {
    const res = await fixture()(
      new Request(XRD_BASE, { headers: { accept: "application/jrd+json" } }),
      env,
      ctx,
    );
    expect(res.headers.get("content-type")).toBe(
      "application/jrd+json; charset=utf-8",
    );
  });
});

describe("host-meta handler — XRD/JRD information equivalence", () => {
  it("advertises the same links in both representations", async () => {
    const handler = fixture();
    const xrd = await (await handler(new Request(XRD_BASE), env, ctx)).text();
    const jrd = (await (
      await handler(new Request(JSON_BASE), env, ctx)
    ).json()) as { links: { rel: string; href?: string; template?: string }[] };

    for (const link of jrd.links) {
      expect(xrd).toContain(`rel="${link.rel}"`);
      if (link.href) expect(xrd).toContain(`href="${link.href}"`);
      if (link.template) {
        expect(xrd).toContain(`template="${link.template}"`);
      }
    }
    // Same number of Link elements as JRD link entries.
    const xrdLinkCount = (xrd.match(/<Link\b/g) ?? []).length;
    expect(xrdLinkCount).toBe(jrd.links.length);
  });
});

describe("host-meta handler — HEAD and OPTIONS", () => {
  it("answers HEAD with headers (incl. Content-Length) but no body", async () => {
    const handler = fixture();
    const head = await handler(
      new Request(XRD_BASE, { method: "HEAD" }),
      env,
      ctx,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(
      "application/xrd+xml; charset=utf-8",
    );
    expect(await head.text()).toBe("");

    // RFC 9110 §9.3.2: the HEAD Content-Length matches what GET would return.
    const get = await handler(new Request(XRD_BASE), env, ctx);
    const getBody = await get.text();
    const expected = String(new TextEncoder().encode(getBody).length);
    expect(head.headers.get("content-length")).toBe(expected);
    expect(get.headers.get("content-length")).toBe(expected);
  });

  it("answers an OPTIONS preflight with CORS headers", async () => {
    const res = await fixture()(
      new Request(XRD_BASE, { method: "OPTIONS" }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("host-meta handler — errors", () => {
  it("returns 405 for a non-GET method with an Allow header", async () => {
    const res = await fixture()(
      new Request(XRD_BASE, { method: "POST" }),
      env,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("host-meta handler — observability", () => {
  it("emits a served event with the negotiated format", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    await fixture({ logger, metrics })(new Request(JSON_BASE), env, ctx);
    const rec = logger.records.find((r) => r.event === HostMetaLogEvent.Served);
    expect(rec?.level).toBe("info");
    expect(rec?.fields?.format).toBe("jrd");
    expect(metrics.events).toContain(HostMetaLogEvent.Served);
  });

  it("emits a rejected event for a disallowed method", async () => {
    const logger = captureLogger();
    await fixture({ logger })(
      new Request(XRD_BASE, { method: "PUT" }),
      env,
      ctx,
    );
    const rec = logger.records.find(
      (r) => r.event === HostMetaLogEvent.Rejected,
    );
    expect(rec?.level).toBe("warn");
    expect(rec?.fields?.reason).toBe("method_not_allowed");
  });
});
