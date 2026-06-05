import { describe, expect, it, vi } from "vitest";

import { createRevocationHandler, type RevocationConfig } from "./revocation";

const ENDPOINT = "https://as.example/revoke";

function postForm(fields: Record<string, string>): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function handler(overrides: Partial<RevocationConfig> = {}) {
  return createRevocationHandler({
    revokeToken: async () => {},
    ...overrides,
  });
}

describe("createRevocationHandler", () => {
  it("revokes a token and returns an empty 200", async () => {
    const revokeToken = vi.fn(async () => {});
    const res = await handler({ revokeToken })(postForm({ token: "tok" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(revokeToken).toHaveBeenCalledWith("tok", undefined);
  });

  it("passes the token_type_hint through", async () => {
    const revokeToken = vi.fn(async () => {});
    await handler({ revokeToken })(
      postForm({ token: "tok", token_type_hint: "refresh_token" }),
    );
    expect(revokeToken).toHaveBeenCalledWith("tok", "refresh_token");
  });

  it("still returns 200 for an unknown token (idempotent)", async () => {
    // The delegate simply finds nothing to revoke; the endpoint must not leak
    // that via the status code.
    const res = await handler()(postForm({ token: "unknown" }));
    expect(res.status).toBe(200);
  });

  it("rejects a missing token with 400 invalid_request", async () => {
    const res = await handler()(postForm({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("authenticates the caller when a hook is supplied", async () => {
    const revokeToken = vi.fn(async () => {});
    const res = await handler({ authenticate: () => false, revokeToken })(
      postForm({ token: "tok" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it("lets a body-reading authenticator coexist with the handler's parse", async () => {
    const revokeToken = vi.fn(async () => {});
    const authenticate = async (req: Request, clientId?: string) => {
      // Reads its own clone of the body and sees the extracted client_id.
      const body = await req.formData();
      return (
        body.get("client_id") === "https://app.example/" &&
        clientId === "https://app.example/"
      );
    };
    const res = await handler({ authenticate, revokeToken })(
      postForm({ token: "tok", client_id: "https://app.example/" }),
    );
    expect(res.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledWith("tok", undefined);
  });

  it("rejects non-POST with 405", async () => {
    const res = await handler()(new Request(ENDPOINT, { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
