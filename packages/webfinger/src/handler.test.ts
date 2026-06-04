import { describe, it, expect } from "vitest";

import {
  createWebfinger,
  WebfingerLogEvent,
  type Logger,
  type Metrics,
  type WebfingerConfig,
  type WebfingerEnv,
} from "./index";

const env: WebfingerEnv = {};
const ctx = {} as ExecutionContext;

const BASE = "https://example.com/.well-known/webfinger";

function get(query: string): Request {
  return new Request(`${BASE}${query}`);
}

const alice: WebfingerConfig["resources"] = {
  "acct:alice@example.com": {
    aliases: ["https://example.com/users/alice"],
    links: [
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: "https://example.com/",
      },
      {
        rel: "self",
        type: "application/activity+json",
        href: "https://example.com/users/alice",
      },
    ],
  },
};

function fixture(extra?: Partial<WebfingerConfig>) {
  return createWebfinger({ resources: alice, ...extra });
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

describe("createWebfinger construction", () => {
  it("throws when no resource source is configured", () => {
    expect(() => createWebfinger({})).toThrow(/at least one resource source/);
  });
});

describe("WebFinger handler — success", () => {
  it("returns 200 with the JRD for a controlled resource", async () => {
    const res = await fixture()(
      get("?resource=acct:alice@example.com"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/jrd+json; charset=utf-8",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subject).toBe("acct:alice@example.com");
    expect(body.aliases).toEqual(["https://example.com/users/alice"]);
    expect((body.links as unknown[]).length).toBe(2);
  });

  it("echoes the queried subject for an https resource (any scheme)", async () => {
    const handler = createWebfinger({
      resources: { "https://example.com/": { links: [{ rel: "self" }] } },
    });
    const res = await handler(get("?resource=https://example.com/"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subject).toBe("https://example.com/");
  });

  it("advertises permissive CORS on a successful response", async () => {
    const res = await fixture()(
      get("?resource=acct:alice@example.com"),
      env,
      ctx,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("WebFinger handler — case-insensitive matching (RFC 7033 §4.1)", () => {
  it("matches a configured resource despite scheme/host case", async () => {
    const res = await fixture()(
      get("?resource=ACCT:alice@EXAMPLE.COM"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("echoes the client's literal resource spelling as the subject", async () => {
    const res = await fixture()(
      get("?resource=ACCT:alice@EXAMPLE.COM"),
      env,
      ctx,
    );
    const body = (await res.json()) as { subject: string };
    expect(body.subject).toBe("ACCT:alice@EXAMPLE.COM");
  });

  it("keeps the acct: local part case-sensitive (different user → 404)", async () => {
    const res = await fixture()(
      get("?resource=acct:ALICE@example.com"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("matches when the configured key itself carries non-canonical case", async () => {
    const handler = createWebfinger({
      resources: { "acct:carol@EXAMPLE.com": { links: [{ rel: "self" }] } },
    });
    const res = await handler(
      get("?resource=acct:carol@example.com"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

describe("WebFinger handler — rel filtering", () => {
  it("returns only the matching link when a rel is supplied", async () => {
    const res = await fixture()(
      get("?resource=acct:alice@example.com&rel=self"),
      env,
      ctx,
    );
    const body = (await res.json()) as { links: { rel: string }[] };
    expect(body.links).toHaveLength(1);
    expect(body.links[0]?.rel).toBe("self");
  });

  it("honors repeated rel parameters", async () => {
    const res = await fixture()(
      get(
        "?resource=acct:alice@example.com&rel=self&rel=http://webfinger.net/rel/profile-page",
      ),
      env,
      ctx,
    );
    const body = (await res.json()) as { links: { rel: string }[] };
    expect(body.links).toHaveLength(2);
  });

  it("returns an empty links array when no link matches the rel", async () => {
    const res = await fixture()(
      get("?resource=acct:alice@example.com&rel=nonexistent"),
      env,
      ctx,
    );
    const body = (await res.json()) as { links: unknown[]; subject: string };
    expect(body.subject).toBe("acct:alice@example.com");
    expect(body.links).toEqual([]);
  });
});

describe("WebFinger handler — errors", () => {
  it("returns 400 when the resource parameter is absent", async () => {
    const res = await fixture()(get(""), env, ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 400 when the resource parameter is empty", async () => {
    const res = await fixture()(get("?resource="), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a resource this server does not control", async () => {
    const res = await fixture()(
      get("?resource=acct:nobody@example.com"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 405 for a non-GET method with an Allow header", async () => {
    const res = await fixture()(
      new Request(`${BASE}?resource=acct:alice@example.com`, {
        method: "POST",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });
});

describe("WebFinger handler — HEAD and OPTIONS", () => {
  it("answers HEAD with headers but no body", async () => {
    const res = await fixture()(
      new Request(`${BASE}?resource=acct:alice@example.com`, {
        method: "HEAD",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/jrd+json; charset=utf-8",
    );
    expect(await res.text()).toBe("");
  });

  it("answers an OPTIONS preflight with CORS headers", async () => {
    const res = await fixture()(
      new Request(BASE, { method: "OPTIONS" }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("WebFinger handler — dynamic resolver", () => {
  it("resolves a resource via the resolver fallback", async () => {
    const handler = createWebfinger({
      resolve: async (resource) =>
        resource === "acct:bob@example.com"
          ? { links: [{ rel: "self", href: "https://example.com/users/bob" }] }
          : undefined,
    });
    const res = await handler(get("?resource=acct:bob@example.com"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string };
    expect(body.subject).toBe("acct:bob@example.com");
  });

  it("returns 404 when the resolver yields undefined", async () => {
    const handler = createWebfinger({ resolve: async () => undefined });
    const res = await handler(
      get("?resource=acct:ghost@example.com"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("WebFinger handler — observability", () => {
  it("emits a resolved event with a sanitized host and rel count", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    await fixture({ logger, metrics })(
      get("?resource=acct:alice@example.com&rel=self"),
      env,
      ctx,
    );
    const rec = logger.records.find(
      (r) => r.event === WebfingerLogEvent.Resolved,
    );
    expect(rec?.level).toBe("info");
    expect(rec?.fields?.resourceHost).toBe("example.com");
    expect(rec?.fields?.relCount).toBe(1);
    expect(metrics.events).toContain(WebfingerLogEvent.Resolved);
  });

  it("emits a rejected event with the not_found reason and host", async () => {
    const logger = captureLogger();
    await fixture({ logger })(
      get("?resource=acct:nobody@example.com"),
      env,
      ctx,
    );
    const rec = logger.records.find(
      (r) => r.event === WebfingerLogEvent.Rejected,
    );
    expect(rec?.level).toBe("warn");
    expect(rec?.fields?.reason).toBe("not_found");
    expect(rec?.fields?.resourceHost).toBe("example.com");
  });

  it("does not log the local part of an acct: handle", async () => {
    const logger = captureLogger();
    await fixture({ logger })(
      get("?resource=acct:secretuser@example.com"),
      env,
      ctx,
    );
    const serialized = JSON.stringify(logger.records);
    expect(serialized).not.toContain("secretuser");
    expect(serialized).toContain("example.com");
  });
});
