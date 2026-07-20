import { describe, expect, it, vi } from "vitest";

import {
  createPushedAuthorizationRequestHandler,
  parseRequestUri,
  requestUriFor,
  PUSHED_REQUEST_URI_PREFIX,
  type PushedAuthorizationRequestConfig,
} from "./par.js";
import type { PushedRequestRecord } from "./store.js";

const ENDPOINT = "https://as.example/par";

function postForm(fields: Record<string, string>, init?: RequestInit): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    body: new URLSearchParams(fields),
    ...init,
  });
}

function handler(overrides: Partial<PushedAuthorizationRequestConfig> = {}) {
  return createPushedAuthorizationRequestHandler({
    saveRequest: async () => {},
    now: () => 1000,
    ...overrides,
  });
}

describe("request_uri helpers", () => {
  it("round-trips a reference through the URN", () => {
    const uri = requestUriFor("abc123");
    expect(uri).toBe(`${PUSHED_REQUEST_URI_PREFIX}abc123`);
    expect(parseRequestUri(uri)).toBe("abc123");
  });

  it("rejects a non-PAR request_uri", () => {
    expect(parseRequestUri("https://example.com/foo")).toBeNull();
    expect(parseRequestUri(PUSHED_REQUEST_URI_PREFIX)).toBeNull();
  });
});

describe("createPushedAuthorizationRequestHandler", () => {
  it("stores the request and returns 201 with a single-use request_uri", async () => {
    let saved: PushedRequestRecord | undefined;
    const res = await handler({
      saveRequest: async (record) => {
        saved = record;
      },
      lifetimeSeconds: 90,
    })(
      postForm({
        client_id: "https://app.example/",
        response_type: "code",
        redirect_uri: "https://app.example/cb",
        code_challenge: "abc",
        code_challenge_method: "S256",
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      request_uri: string;
      expires_in: number;
    };
    expect(body.expires_in).toBe(90);
    expect(saved).toBeDefined();
    expect(parseRequestUri(body.request_uri)).toBe(saved?.reference);
    expect(saved?.clientId).toBe("https://app.example/");
    expect(saved?.expiresAt).toBe(1090);
    expect(saved?.params.response_type).toBe("code");
    expect(saved?.params.code_challenge).toBe("abc");
  });

  it("never persists client-authentication credentials into the stored record", async () => {
    let saved: PushedRequestRecord | undefined;
    const res = await handler({
      saveRequest: async (record) => {
        saved = record;
      },
    })(
      postForm({
        client_id: "https://app.example/",
        client_secret: "s3cret",
        client_assertion: "ey.assertion.jwt",
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        response_type: "code",
        code_challenge: "abc",
      }),
    );
    expect(res.status).toBe(201);
    expect(saved?.params.response_type).toBe("code");
    expect(saved?.params.code_challenge).toBe("abc");
    // The credential-bearing parameters must not survive into storage.
    expect(saved?.params.client_secret).toBeUndefined();
    expect(saved?.params.client_assertion).toBeUndefined();
    expect(saved?.params.client_assertion_type).toBeUndefined();
  });

  it("rejects a body with a duplicated parameter (RFC 6749 §3.2)", async () => {
    // Two `client_id`s: last-wins parsing here vs first-wins in an authenticator
    // could authenticate as one client but attribute the request to another.
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=https%3A%2F%2Fapp.example%2F&client_id=https%3A%2F%2Fevil.example%2F&response_type=code",
    });
    const res = await handler()(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a body that smuggles its own request_uri", async () => {
    const res = await handler()(
      postForm({
        client_id: "https://app.example/",
        request_uri: "urn:evil",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a missing client_id", async () => {
    const res = await handler()(postForm({ response_type: "code" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("applies the validate hook, rejecting on a returned description", async () => {
    const res = await handler({
      validate: (params) => (params.code_challenge ? null : "PKCE required"),
    })(postForm({ client_id: "https://app.example/" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "PKCE required",
    });
  });

  it("accepts when the validate hook passes", async () => {
    const res = await handler({
      validate: () => null,
    })(postForm({ client_id: "https://app.example/", code_challenge: "x" }));
    expect(res.status).toBe(201);
  });

  it("authenticates the caller when a hook is supplied", async () => {
    const saveRequest = vi.fn(async () => {});
    const res = await handler({ authenticate: () => false, saveRequest })(
      postForm({ client_id: "https://app.example/" }),
    );
    expect(res.status).toBe(401);
    expect(saveRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid DPoP proof when binding is enabled", async () => {
    const res = await handler({
      dpopBinding: true,
      endpoint: ENDPOINT,
    })(
      postForm(
        { client_id: "https://app.example/" },
        { headers: { DPoP: "not-a-valid-proof" } },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_dpop_proof" });
  });

  it("stores no jkt when DPoP binding is enabled but no proof is sent", async () => {
    let saved: PushedRequestRecord | undefined;
    const res = await handler({
      dpopBinding: true,
      saveRequest: async (record) => {
        saved = record;
      },
    })(postForm({ client_id: "https://app.example/" }));
    expect(res.status).toBe(201);
    expect(saved?.jkt).toBeUndefined();
  });

  it("passes the extracted client_id to the authenticator (RFC 9126 §2.1)", async () => {
    const authenticate = vi.fn((_req: Request, _clientId?: string) => true);
    await handler({ authenticate })(
      postForm({ client_id: "https://app.example/", response_type: "code" }),
    );
    const [req, clientId] = authenticate.mock.calls[0]!;
    expect(req).toBeInstanceOf(Request);
    expect(clientId).toBe("https://app.example/");
  });

  it("lets a body-reading authenticator coexist with the handler's store", async () => {
    let saved: PushedRequestRecord | undefined;
    const authenticate = async (req: Request) => {
      const body = await req.formData();
      return body.get("client_id") === "https://app.example/";
    };
    const res = await handler({
      authenticate,
      saveRequest: async (record) => {
        saved = record;
      },
    })(postForm({ client_id: "https://app.example/", response_type: "code" }));
    expect(res.status).toBe(201);
    expect(saved?.params.response_type).toBe("code");
  });

  it("rejects non-POST with 405", async () => {
    const res = await handler()(new Request(ENDPOINT, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
