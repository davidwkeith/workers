/**
 * `@dwk/mastodon-api` — a Mastodon-compatible client API subset.
 *
 * An endpoint package (Cloudflare specifics allowed): off-the-shelf
 * Mastodon-API clients (Pixelfed's app, Tusky, Elk) log in via the
 * Mastodon-shaped app OAuth flow — built on `@dwk/oauth`'s building blocks,
 * with opaque SHA-256-hashed bearer tokens in D1 as the repo's documented,
 * mitigated exception to the DPoP-everywhere rule — and browse a **read-only**
 * surface. Publishing stays with micropub/MCP; this package adds no write
 * path. The Durable-Object-backed data arrives through the injected
 * {@link MastodonBackend} seam, which `@dwk/activitypub`'s
 * `createActivitypubMastodonApi` adapter implements (the webdav/solid-pod
 * precedent); the protocol core here has no DO knowledge and tests against
 * in-memory fakes.
 *
 * @see spec/packages/mastodon-api.md
 * @packageDocumentation
 */

export { createMastodonApi } from "./handler.js";
export {
  OWNER_ACCOUNT_ID,
  type MastodonApiConfig,
  type MastodonApiEnv,
  type InstanceMetadata,
  type OwnerAccount,
  type MastodonAuthorizationRequest,
  type MastodonApproval,
  type ApproveMastodonAuthorization,
} from "./config.js";
export type {
  MastodonBackend,
  BackendAccount,
  BackendAccountCounts,
  BackendPage,
  BackendPageQuery,
  BackendEntry,
} from "./backend.js";
export { mastodonError } from "./errors.js";
export {
  encodeSnowflake,
  decodeSnowflake,
  type DecodedSnowflake,
} from "./snowflake.js";
export {
  encodeRemoteAccountId,
  decodeRemoteAccountId,
  remoteAccountEntity,
  statusEntity,
  notificationEntity,
} from "./entities.js";
