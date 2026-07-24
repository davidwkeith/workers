/**
 * Configuration + Cloudflare bindings for {@link createSolidOidc}. Per the
 * composition contract the package never reads the global environment for
 * anything but its declared bindings; issuer, WebID, lifetimes, and the
 * approval hook all arrive through the factory config.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { Logger, Metrics } from "@dwk/log";

import type { Jwk } from "./jws.js";

/** Cloudflare bindings required by `@dwk/solid-oidc`. */
export interface SolidOidcEnv {
  /** D1 database holding authorization codes (shared `AUTH_DB`). */
  readonly AUTH_DB: D1Database;
}

/**
 * The affirmative decision the approval hook returns to mint a code: the
 * authenticated owner's WebID, and the scopes actually granted (defaults to the
 * requested scope when omitted).
 */
export interface SolidOidcApproval {
  /** The authenticated agent's WebID URL — becomes the token's `webid`. */
  readonly webid: string;
  /** Granted scope; defaults to the request's `scope`. */
  readonly scope?: string;
}

/** A validated authorization request handed to the approval hook. */
export interface SolidOidcAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state?: string;
  readonly nonce?: string;
  readonly codeChallenge: string;
}

/**
 * Owner authentication + consent hook (the IndieAuth pattern). Return a
 * {@link SolidOidcApproval} to mint a code and redirect, or a `Response` to
 * take over (render a login/consent page); the returned `Response` is served
 * unchanged.
 */
export type ApproveSolidOidcAuthorization = (
  request: SolidOidcAuthorizationRequest,
  httpRequest: Request,
) => Promise<SolidOidcApproval | Response>;

/** Configuration passed to {@link createSolidOidc}. */
export interface SolidOidcConfig {
  /**
   * The OP issuer — its own origin (e.g. `https://id.example`). Also the value
   * a Solid pod matches against a token's `iss`. No trailing slash.
   */
  readonly issuer: string;
  /**
   * The ES256 signing key as a private JWK (a composer-injected secret). Its
   * public half is published at the JWKS endpoint; production deployments
   * persist this outside source. See {@link generateSigningJwk} to mint one.
   */
  readonly signingKey: Jwk;
  /** Owner authentication + consent hook. */
  readonly approveAuthorization: ApproveSolidOidcAuthorization;
  /**
   * Audience(s) stamped into issued access tokens (RFC 8707). A Solid pod
   * accepts a token whose `aud` intersects its own set (default
   * `["solid", <pod origin>]`), so this MUST include `"solid"` and/or the
   * target pod origin(s). Defaults to `["solid"]`.
   */
  readonly audience?: readonly string[];
  /** Scopes advertised in discovery. Defaults to `["openid", "webid", "offline_access"]`. */
  readonly scopesSupported?: readonly string[];
  /** Access-token lifetime in seconds. Defaults to 3600. */
  readonly accessTokenLifetimeSeconds?: number;
  /** ID-token lifetime in seconds. Defaults to 3600. */
  readonly idTokenLifetimeSeconds?: number;
  /** Authorization-code lifetime in seconds. Defaults to 600. */
  readonly authorizationCodeLifetimeSeconds?: number;
  /** Path prefix the handler is mounted under (default `""`, i.e. root). */
  readonly mountPath?: string;
  /** Structured logger; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics sink; defaults to a no-op. */
  readonly metrics?: Metrics;
  /** Clock override (epoch ms) for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Resolved config with defaults applied and endpoint URLs derived. */
export interface ResolvedSolidOidcConfig {
  readonly issuer: string;
  readonly signingKey: Jwk;
  readonly approveAuthorization: ApproveSolidOidcAuthorization;
  readonly audience: readonly string[];
  readonly scopesSupported: readonly string[];
  readonly accessTokenLifetimeSeconds: number;
  readonly idTokenLifetimeSeconds: number;
  readonly authorizationCodeLifetimeSeconds: number;
  readonly mountPath: string;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly now: () => number;
  /** Absolute endpoint URLs derived from `issuer` + `mountPath`. */
  readonly endpoints: {
    readonly authorization: string;
    readonly token: string;
    readonly jwks: string;
    readonly discovery: string;
  };
  /** Path (no origin) of each route, for the router to match. */
  readonly paths: {
    readonly authorization: string;
    readonly token: string;
    readonly jwks: string;
    readonly discovery: string;
  };
}

/** Apply defaults and derive endpoint URLs/paths. Throws on a bad `issuer`. */
export function resolveConfig(
  config: SolidOidcConfig,
): ResolvedSolidOidcConfig {
  const issuer = config.issuer.replace(/\/$/, "");
  const prefix = config.mountPath ? config.mountPath.replace(/\/$/, "") : "";
  const authPath = `${prefix}/authorize`;
  const tokenPath = `${prefix}/token`;
  const jwksPath = `${prefix}/jwks`;
  // The discovery document is authority-bound to a fixed well-known path.
  const discoveryPath = "/.well-known/openid-configuration";
  return {
    issuer,
    signingKey: config.signingKey,
    approveAuthorization: config.approveAuthorization,
    audience: config.audience ?? ["solid"],
    scopesSupported: config.scopesSupported ?? [
      "openid",
      "webid",
      "offline_access",
    ],
    accessTokenLifetimeSeconds: config.accessTokenLifetimeSeconds ?? 3600,
    idTokenLifetimeSeconds: config.idTokenLifetimeSeconds ?? 3600,
    authorizationCodeLifetimeSeconds:
      config.authorizationCodeLifetimeSeconds ?? 600,
    mountPath: prefix,
    ...(config.logger ? { logger: config.logger } : {}),
    ...(config.metrics ? { metrics: config.metrics } : {}),
    now: config.now ?? (() => Date.now()),
    endpoints: {
      authorization: `${issuer}${authPath}`,
      token: `${issuer}${tokenPath}`,
      jwks: `${issuer}${jwksPath}`,
      discovery: `${issuer}${discoveryPath}`,
    },
    paths: {
      authorization: authPath,
      token: tokenPath,
      jwks: jwksPath,
      discovery: discoveryPath,
    },
  };
}
