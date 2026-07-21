import { describe, expect, it, vi } from "vitest";

import {
  createClientRegistrationHandler,
  validateClientMetadata,
  type ClientRegistrationConfig,
} from "./registration.js";
import type { ClientRecord } from "./store.js";

const ENDPOINT = "https://as.example/register";

function postJson(body: unknown, raw?: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function handler(overrides: Partial<ClientRegistrationConfig> = {}) {
  return createClientRegistrationHandler({
    saveClient: async () => {},
    generateClientId: () => "client-1",
    generateClientSecret: () => "secret-1",
    now: () => 1000,
    ...overrides,
  });
}

describe("validateClientMetadata", () => {
  const config: ClientRegistrationConfig = { saveClient: async () => {} };

  it("rejects a non-object body", () => {
    expect(validateClientMetadata("nope", config)).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("applies defaults for grant/response types and auth method", () => {
    const result = validateClientMetadata(
      { redirect_uris: ["https://app.example/cb"] },
      config,
    );
    expect(result).toEqual({
      metadata: {
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: ["https://app.example/cb"],
      },
    });
  });

  it("requires redirect_uris for the authorization_code grant", () => {
    expect(validateClientMetadata({}, config)).toMatchObject({
      error: "invalid_redirect_uri",
    });
  });

  it("rejects a redirect_uri carrying a fragment", () => {
    expect(
      validateClientMetadata(
        { redirect_uris: ["https://app.example/cb#frag"] },
        config,
      ),
    ).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("rejects redirect_uris that is not an array of strings", () => {
    expect(
      validateClientMetadata(
        { redirect_uris: "https://app.example/cb" },
        config,
      ),
    ).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("enforces a redirectUriPolicy", () => {
    const result = validateClientMetadata(
      { redirect_uris: ["https://evil.example/cb"] },
      {
        saveClient: async () => {},
        redirectUriPolicy: (uri) => uri.startsWith("https://app.example/"),
      },
    );
    expect(result).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("rejects an unsupported token_endpoint_auth_method", () => {
    expect(
      validateClientMetadata(
        {
          redirect_uris: ["https://app.example/cb"],
          token_endpoint_auth_method: "private_key_jwt",
        },
        config,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("rejects an unsupported grant_type", () => {
    expect(
      validateClientMetadata(
        {
          redirect_uris: ["https://app.example/cb"],
          grant_types: ["password"],
        },
        config,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("rejects an inconsistent grant/response-type pairing", () => {
    expect(
      validateClientMetadata(
        {
          redirect_uris: ["https://app.example/cb"],
          grant_types: ["authorization_code"],
          response_types: [],
        },
        config,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("rejects a non-string recognized field", () => {
    expect(
      validateClientMetadata(
        { redirect_uris: ["https://app.example/cb"], client_name: 42 },
        config,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("rejects contacts that is not an array of strings", () => {
    expect(
      validateClientMetadata(
        { redirect_uris: ["https://app.example/cb"], contacts: "a@b.example" },
        config,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("retains recognized metadata and drops unknown members", () => {
    const result = validateClientMetadata(
      {
        redirect_uris: ["https://app.example/cb"],
        client_name: "App",
        scope: "read write",
        contacts: ["a@b.example"],
        bogus_field: "ignored",
      },
      config,
    );
    expect(result).toMatchObject({
      metadata: {
        client_name: "App",
        scope: "read write",
        contacts: ["a@b.example"],
      },
    });
    expect(
      (result as { metadata: Record<string, unknown> }).metadata,
    ).not.toHaveProperty("bogus_field");
  });

  it("never echoes an untrusted submitted value back in error_description", () => {
    const injected = '"><script>alert(1)</script>';
    const cases: unknown[] = [
      {
        redirect_uris: ["https://app.example/cb"],
        token_endpoint_auth_method: injected,
      },
      { redirect_uris: ["https://app.example/cb"], grant_types: [injected] },
      {
        redirect_uris: ["https://app.example/cb"],
        response_types: [injected],
      },
      { redirect_uris: [injected] },
    ];
    for (const input of cases) {
      const result = validateClientMetadata(input, config);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.description).not.toContain(injected);
      }
    }
  });
});

describe("createClientRegistrationHandler", () => {
  it("registers a confidential client and returns 201 with a secret", async () => {
    let saved: ClientRecord | undefined;
    const res = await handler({
      saveClient: async (record) => {
        saved = record;
      },
    })(postJson({ redirect_uris: ["https://app.example/cb"] }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      client_id: "client-1",
      client_id_issued_at: 1000,
      client_secret: "secret-1",
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: ["https://app.example/cb"],
    });
    expect(saved?.clientId).toBe("client-1");
    expect(saved?.clientSecret).toBe("secret-1");
  });

  it("issues no secret for a public client (auth method none)", async () => {
    const res = await handler()(
      postJson({
        redirect_uris: ["https://app.example/cb"],
        token_endpoint_auth_method: "none",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("client_secret");
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("returns the validation error for invalid metadata", async () => {
    const res = await handler()(postJson({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("treats a malformed JSON body as invalid client metadata", async () => {
    const res = await handler()(postJson(null, "{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("authenticates the caller when a hook is supplied", async () => {
    const saveClient = vi.fn(async () => {});
    const res = await handler({ authenticate: () => false, saveClient })(
      postJson({ redirect_uris: ["https://app.example/cb"] }),
    );
    expect(res.status).toBe(401);
    expect(saveClient).not.toHaveBeenCalled();
  });

  it("scopes the WWW-Authenticate challenge to Basic for a client_secret_basic caller", async () => {
    const res = await handler({ authenticate: () => false })(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Basic dXNlcjpwYXNz",
        },
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="oauth"');
  });

  it("rejects non-POST with 405", async () => {
    const res = await handler()(new Request(ENDPOINT, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("treats a body over the size cap as invalid client metadata rather than buffering it in full", async () => {
    const huge = JSON.stringify({
      redirect_uris: ["https://app.example/cb"],
      client_name: "x".repeat(200_000),
    });
    const res = await handler()(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_client_metadata",
    });
  });
});
