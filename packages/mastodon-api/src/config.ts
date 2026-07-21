/**
 * Configuration for {@link createMastodonApi}. Per the composition contract the
 * package never reads the global environment — instance metadata, the owner
 * account, and the approval hook all arrive here, so it can be instantiated
 * multiple times and tested in isolation.
 */

import type { MastodonBackend } from "./backend.js";

/** Cloudflare bindings required by `@dwk/mastodon-api`. */
export interface MastodonApiEnv {
  /** D1 database holding apps, codes, tokens, and markers (shared `AUTH_DB`). */
  readonly AUTH_DB: D1Database;
}

/** Instance-level metadata served by the `instance` endpoints. */
export interface InstanceMetadata {
  /** Instance title. */
  readonly title: string;
  /** Longer instance description. */
  readonly description?: string;
  /** Contact email surfaced in the instance documents. */
  readonly contactEmail?: string;
  /** ISO 639-1 content languages. Defaults to `["en"]`. */
  readonly languages?: readonly string[];
  /** Thumbnail image URL. */
  readonly thumbnail?: string;
}

/** The single owner account this deployment serves. */
export interface OwnerAccount {
  /** The `acct:` local part / login handle. */
  readonly username: string;
  /** Display name; defaults to {@link username}. */
  readonly displayName?: string;
  /** Bio, as HTML. Defaults to empty. */
  readonly note?: string;
  /** Profile page URL; defaults to `${baseUrl}/users/${username}`. */
  readonly url?: string;
  /** Avatar image URL; a transparent-pixel data URI when unset. */
  readonly avatar?: string;
  /** Header image URL; a transparent-pixel data URI when unset. */
  readonly header?: string;
  /** Account creation date (ISO 8601). Defaults to the Unix epoch. */
  readonly createdAt?: string;
}

/** A validated authorization request handed to the approval hook. */
export interface MastodonAuthorizationRequest {
  readonly clientId: string;
  /** Registered `client_name`, for the consent screen. */
  readonly clientName: string;
  /** The exact-matched redirect URI (may be `urn:ietf:wg:oauth:2.0:oob`). */
  readonly redirectUri: string;
  /** Space-separated requested scopes (echoed as granted, never narrowed). */
  readonly scope: string;
  readonly scopes: readonly string[];
  /** Opaque client state, echoed back on redirect. */
  readonly state?: string;
}

/** The approval hook's affirmative decision. */
export interface MastodonApproval {
  readonly approved: true;
}

/**
 * Authentication + consent hook — the deployer's concern, exactly as
 * `@dwk/indieauth`'s `approveAuthorization`. Return a {@link MastodonApproval}
 * to mint a code and redirect, or a `Response` to take over the exchange
 * (render a login/consent page); the library returns that `Response` unchanged.
 */
export type ApproveMastodonAuthorization = (
  request: MastodonAuthorizationRequest,
  httpRequest: Request,
) => Promise<MastodonApproval | Response>;

/** Configuration passed to {@link createMastodonApi}. */
export interface MastodonApiConfig {
  /** Public origin of the composed Worker, e.g. `https://example.com`. */
  readonly baseUrl: string;
  readonly instance: InstanceMetadata;
  readonly account: OwnerAccount;
  readonly approveAuthorization: ApproveMastodonAuthorization;
  /**
   * Suffix for the compatibility `version` string
   * `"4.2.0 (compatible; dwk-workers/<softwareVersion>)"`. Defaults to `"0"`.
   */
  readonly softwareVersion?: string;
  /** Authorization-code lifetime in seconds. Defaults to 600. */
  readonly authorizationCodeLifetimeSeconds?: number;
  /** Page-size defaults/ceiling for the phase-2 list endpoints. */
  readonly pageSize?: { readonly default: number; readonly max: number };
  /** Live-count + timeline backend; absent in phase 1 (counts render as 0). */
  readonly backend?: MastodonBackend;
}

/** The one local account id this deployment ever mints (single-owner). */
export const OWNER_ACCOUNT_ID = "1";
