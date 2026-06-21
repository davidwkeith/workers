import { describe, expect, it, vi } from "vitest";

import {
  buildIntrospectionResponse,
  createIntrospectionHandler,
  isTokenActive,
  type IntrospectionConfig,
} from "./introspection.js";
import type { IntrospectionTokenRecord } from "./store.js";

const ENDPOINT = "https://as.example/introspect";

function postForm(fields: Record<string, string>, init?: RequestInit): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    body: new URLSearchParams(fields),
    ...init,
  });
}

function handler(overrides: Partial<IntrospectionConfig> = {}) {
  return createIntrospectionHandler({
    lookupToken: async () => null,
    authenticate: () => true,
    now: () => 1000,
    ...overrides,
  });
}

describe("isTokenActive", () => {
  it("treats a null lookup as inactive", () => {
    expect(isTokenActive(null, 1000)).toBe(false);
  });

  it("respects an explicit active flag and revocation", () => {
    expect(isTokenActive({ active: false }, 1000)).toBe(false);
    expect(isTokenActive({ revoked: true }, 1000)).toBe(false);
    expect(isTokenActive({}, 1000)).toBe(true);
  });

  it("enforces the exp/nbf window", () => {
    expect(isTokenActive({ expiresAt: 1000 }, 1000)).toBe(false);
    expect(isTokenActive({ expiresAt: 1001 }, 1000)).toBe(true);
    expect(isTokenActive({ notBefore: 1001 }, 1000)).toBe(false);
    expect(isTokenActive({ notBefore: 1000 }, 1000)).toBe(true);
  });
});

describe("buildIntrospectionResponse", () => {
  it("maps camelCase record fields to snake_case members", () => {
    const record: IntrospectionTokenRecord = {
      scope: "read write",
      clientId: "https://app.example/",
      username: "alice",
      tokenType: "DPoP",
      expiresAt: 2000,
      issuedAt: 1000,
      notBefore: 1000,
      subject: "https://alice.example/",
      audience: ["https://rs.example/"],
      issuer: "https://as.example/",
      tokenId: "jti-1",
      jkt: "thumb-1",
    };
    expect(buildIntrospectionResponse(record)).toEqual({
      active: true,
      scope: "read write",
      client_id: "https://app.example/",
      username: "alice",
      token_type: "DPoP",
      exp: 2000,
      iat: 1000,
      nbf: 1000,
      sub: "https://alice.example/",
      aud: ["https://rs.example/"],
      iss: "https://as.example/",
      jti: "jti-1",
      cnf: { jkt: "thumb-1" },
    });
  });

  it("emits only the members the record carries", () => {
    expect(buildIntrospectionResponse({ scope: "read" })).toEqual({
      active: true,
      scope: "read",
    });
  });
});

describe("createIntrospectionHandler", () => {
  it("returns the mapped response for an active token", async () => {
    const res = await handler({
      lookupToken: async () => ({
        clientId: "https://app.example/",
        scope: "read",
        expiresAt: 2000,
        jkt: "thumb-1",
      }),
    })(postForm({ token: "tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true,
      client_id: "https://app.example/",
      scope: "read",
      exp: 2000,
      cnf: { jkt: "thumb-1" },
    });
  });

  it("returns { active: false } for an expired token", async () => {
    const res = await handler({
      lookupToken: async () => ({ scope: "read", expiresAt: 500 }),
    })(postForm({ token: "tok" }));
    expect(await res.json()).toEqual({ active: false });
  });

  it("returns { active: false } for a revoked token", async () => {
    const res = await handler({
      lookupToken: async () => ({ revoked: true }),
    })(postForm({ token: "tok" }));
    expect(await res.json()).toEqual({ active: false });
  });

  it("returns { active: false } for an unknown token", async () => {
    const res = await handler()(postForm({ token: "nope" }));
    expect(await res.json()).toEqual({ active: false });
  });

  it("passes the token and token_type_hint to the lookup", async () => {
    const lookupToken = vi.fn(async () => null);
    await handler({ lookupToken })(
      postForm({ token: "tok", token_type_hint: "access_token" }),
    );
    expect(lookupToken).toHaveBeenCalledWith("tok", "access_token");
  });

  it("rejects a missing token with 400 invalid_request", async () => {
    const res = await handler()(postForm({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects an unauthenticated caller with 401 invalid_client", async () => {
    const res = await handler({ authenticate: () => false })(
      postForm({ token: "tok" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("does not look the token up when authentication fails", async () => {
    const lookupToken = vi.fn(async () => null);
    await handler({ authenticate: () => false, lookupToken })(
      postForm({ token: "tok" }),
    );
    expect(lookupToken).not.toHaveBeenCalled();
  });

  it("passes the request and any extracted client_id to the authenticator", async () => {
    const authenticate = vi.fn((_req: Request, _clientId?: string) => true);
    await handler({ authenticate })(
      postForm({ token: "tok", client_id: "https://app.example/" }),
    );
    expect(authenticate).toHaveBeenCalledTimes(1);
    const [req, clientId] = authenticate.mock.calls[0]!;
    expect(req).toBeInstanceOf(Request);
    expect(clientId).toBe("https://app.example/");
  });

  it("lets a body-reading authenticator coexist with the handler's parse", async () => {
    // The authenticator consumes its own (cloned) copy of the body; the
    // handler must still parse `token` from the original — a 400 here would
    // mean the body was consumed out from under it.
    const authenticate = async (req: Request) => {
      const body = await req.formData();
      return body.get("client_id") === "https://app.example/";
    };
    const res = await handler({ authenticate })(
      postForm({ token: "tok", client_id: "https://app.example/" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });

  it("rejects non-POST with 405", async () => {
    const res = await handler()(new Request(ENDPOINT, { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
