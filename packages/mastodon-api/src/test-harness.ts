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
