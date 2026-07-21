/**
 * Shared test fixtures (excluded from the build and the published `files`).
 */

import { env } from "cloudflare:test";

import { createMastodonApi } from "./handler.js";
import type { MastodonApiConfig, MastodonApiEnv } from "./config.js";

/** A minimal, valid config for driving the handler in tests. */
export const testConfig: MastodonApiConfig = {
  baseUrl: "https://owner.example",
  instance: { title: "Owner's site" },
  account: { username: "owner" },
  approveAuthorization: async () => ({ approved: true }),
};

export const testCtx = {} as ExecutionContext;

/** The Miniflare-provided bindings, typed as the package's Env fragment. */
export const testEnv = env as unknown as MastodonApiEnv;

/** Build a one-shot fetcher over {@link createMastodonApi}. */
export function api(
  cfg: MastodonApiConfig = testConfig,
): (request: Request) => Promise<Response> {
  const handler = createMastodonApi(cfg);
  return (request) => handler(request, testEnv, testCtx);
}

/** Drop every package table so each test starts from a fresh schema. */
export async function resetDb(): Promise<void> {
  for (const table of [
    "mastodon_apps",
    "mastodon_codes",
    "mastodon_tokens",
    "mastodon_markers",
  ]) {
    await testEnv.AUTH_DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** The app-registration response shape used across the endpoint tests. */
export interface AppResponse {
  readonly id: string;
  readonly name: string;
  readonly website: string | null;
  readonly redirect_uri: string;
  readonly redirect_uris: readonly string[];
  readonly client_id: string;
  readonly client_secret: string;
}

/** Register an app through the real endpoint; throws on a non-200. */
export async function registerApp(
  overrides: Record<string, unknown> = {},
): Promise<AppResponse> {
  const res = await api()(
    new Request("https://owner.example/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Tusky",
        redirect_uris: "app://oauth-callback",
        scopes: "read write follow push",
        website: "https://tusky.app",
        ...overrides,
      }),
    }),
  );
  if (res.status !== 200) {
    throw new Error(`registerApp: unexpected ${res.status}`);
  }
  return (await res.json()) as AppResponse;
}

/**
 * Complete the whole login flow through the real endpoints and return a
 * usable bearer token. `grantType` selects an owner-bound token
 * (`authorization_code`) or an app-level one (`client_credentials`).
 */
export async function obtainAccessToken(
  grantType: "authorization_code" | "client_credentials" = "authorization_code",
): Promise<string> {
  const app = await registerApp();
  const fields: Record<string, string> = {
    grant_type: grantType,
    client_id: app.client_id,
    client_secret: app.client_secret,
  };
  if (grantType === "authorization_code") {
    const authorize = new URL("https://owner.example/oauth/authorize");
    authorize.searchParams.set("client_id", app.client_id);
    authorize.searchParams.set("redirect_uri", "app://oauth-callback");
    authorize.searchParams.set("response_type", "code");
    const redirect = await api()(new Request(authorize.toString()));
    const code = new URL(
      redirect.headers.get("location") ?? "",
    ).searchParams.get("code");
    if (!code) throw new Error("obtainAccessToken: authorize minted no code");
    fields["redirect_uri"] = "app://oauth-callback";
    fields["code"] = code;
  }
  const res = await api()(
    new Request("https://owner.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
  if (res.status !== 200) {
    throw new Error(`obtainAccessToken: unexpected ${res.status}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}
