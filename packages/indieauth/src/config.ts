/**
 * Configuration for {@link createIndieAuth}: endpoint URLs, lifetimes, supported
 * scopes, the redirect-URI policy, and the delegated authentication/consent
 * hook. Per the composition contract, the package never reads the global
 * environment — every tunable arrives here, so it can be instantiated multiple
 * times and tested in isolation.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

/** DPoP proof signing algorithms advertised in the metadata document. */
export const DPOP_SIGNING_ALG_VALUES_SUPPORTED = [
  "ES256",
  "ES384",
  "RS256",
  "PS256",
] as const;

const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;
const DEFAULT_AUTHORIZATION_CODE_LIFETIME_SECONDS = 600;

/** A parsed, validated authorization request handed to {@link IndieAuthConfig.approveAuthorization}. */
export interface AuthorizationRequest {
  /** The client identifier URL. */
  readonly clientId: string;
  /** The validated redirect URI the code will be delivered to. */
  readonly redirectUri: string;
  /** Opaque client state, echoed back on redirect. */
  readonly state: string;
  /** PKCE challenge (`S256`). */
  readonly codeChallenge: string;
  /** PKCE challenge method — always `"S256"` for this server. */
  readonly codeChallengeMethod: string;
  /** Space-separated requested scopes (may be empty). */
  readonly scope: string;
  /** Requested scopes as a list. */
  readonly scopes: readonly string[];
  /** The profile URL hint supplied by the client (`me`), if any. */
  readonly me?: string;
}

/** Optional profile information returned to the client on redemption. */
export interface ProfileInfo {
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
  readonly email?: string;
}

/** The decision returned by {@link IndieAuthConfig.approveAuthorization} when the request is approved. */
export interface AuthorizationApproval {
  /** The verified canonical profile URL of the authenticated user. */
  readonly me: string;
  /** Scopes actually granted (defaults to the requested scopes). */
  readonly scopes?: readonly string[];
  /** Optional profile information returned alongside `me`. */
  readonly profile?: ProfileInfo;
}

/**
 * Authentication + consent hook. The library owns all protocol mechanics;
 * authenticating the user and obtaining consent is the deployer's concern.
 *
 * Return an {@link AuthorizationApproval} to mint a code and redirect, or a
 * `Response` to take over the exchange (render a login/consent page, redirect
 * to an external identity provider, etc.). The library returns that `Response`
 * unchanged.
 */
export type ApproveAuthorization = (
  request: AuthorizationRequest,
  httpRequest: Request,
) => Promise<AuthorizationApproval | Response>;

/** Decides whether a `redirect_uri` is acceptable for a given `client_id`. */
export type RedirectUriPolicy = (
  clientId: string,
  redirectUri: string,
) => boolean | Promise<boolean>;

/** Configuration passed to {@link createIndieAuth}. */
export interface IndieAuthConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
  /** The token issuer identifier. Defaults to `baseUrl`. */
  readonly issuer?: string;
  /** Absolute authorization endpoint URL. Defaults to `${baseUrl}/authorize`. */
  readonly authorizationEndpoint?: string;
  /** Absolute token endpoint URL. Defaults to `${baseUrl}/token`. */
  readonly tokenEndpoint?: string;
  /** Absolute revocation endpoint URL. Defaults to `${baseUrl}/revocation`. */
  readonly revocationEndpoint?: string;
  /**
   * Absolute metadata endpoint URL. Defaults to
   * `${baseUrl}/.well-known/oauth-authorization-server`.
   */
  readonly metadataEndpoint?: string;
  /** Scopes this server is willing to issue, advertised in metadata. */
  readonly scopesSupported?: readonly string[];
  /** Access-token lifetime in seconds. Defaults to 3600. */
  readonly accessTokenLifetimeSeconds?: number;
  /** Authorization-code lifetime in seconds. Defaults to 600. */
  readonly authorizationCodeLifetimeSeconds?: number;
  /**
   * Redirect-URI policy. Defaults to same-origin as `client_id`, the IndieAuth
   * baseline when no client metadata is registered.
   */
  readonly redirectUriPolicy?: RedirectUriPolicy;
  /** Authentication + consent hook (see {@link ApproveAuthorization}). */
  readonly approveAuthorization: ApproveAuthorization;
  /**
   * Logger for authorization/token/revocation events; defaults to a no-op. Wire
   * a real logger (see `@dwk/log`) to surface authorization rejections, token
   * rejections, and revocations instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for the same events; defaults to a no-op. Wire an adapter (e.g.
   * `analyticsEngineMetrics` from `@dwk/log`) to chart what the logger names —
   * authorization rejections/min, token issuance rate, rejections by reason.
   */
  readonly metrics?: Metrics;
}

/** Fully resolved configuration with defaults applied and URLs parsed. */
export interface ResolvedConfig {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly metadataEndpoint: string;
  readonly authorizationPath: string;
  readonly tokenPath: string;
  readonly revocationPath: string;
  readonly metadataPath: string;
  readonly scopesSupported: readonly string[];
  readonly accessTokenLifetimeSeconds: number;
  readonly authorizationCodeLifetimeSeconds: number;
  readonly redirectUriPolicy: RedirectUriPolicy;
  readonly approveAuthorization: ApproveAuthorization;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/** Default policy: the redirect URI must share an origin with the client id. */
function sameOriginRedirect(clientId: string, redirectUri: string): boolean {
  try {
    return new URL(clientId).origin === new URL(redirectUri).origin;
  } catch {
    return false;
  }
}

function pathOf(absoluteUrl: string, label: string): string {
  try {
    return new URL(absoluteUrl).pathname;
  } catch {
    throw new Error(`@dwk/indieauth: ${label} is not a valid URL`);
  }
}

/**
 * Resolve user config into a {@link ResolvedConfig}, applying defaults and
 * pre-computing each endpoint's pathname for request routing. Throws if
 * `baseUrl` (or any explicitly supplied endpoint URL) is not a valid URL.
 */
export function resolveConfig(config: IndieAuthConfig): ResolvedConfig {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error("@dwk/indieauth: `baseUrl` is not a valid URL");
  }
  const origin = base.origin;

  const issuer = config.issuer ?? config.baseUrl;
  const authorizationEndpoint =
    config.authorizationEndpoint ?? `${origin}/authorize`;
  const tokenEndpoint = config.tokenEndpoint ?? `${origin}/token`;
  const revocationEndpoint =
    config.revocationEndpoint ?? `${origin}/revocation`;
  const metadataEndpoint =
    config.metadataEndpoint ??
    `${origin}/.well-known/oauth-authorization-server`;

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
    metadataEndpoint,
    authorizationPath: pathOf(authorizationEndpoint, "authorizationEndpoint"),
    tokenPath: pathOf(tokenEndpoint, "tokenEndpoint"),
    revocationPath: pathOf(revocationEndpoint, "revocationEndpoint"),
    metadataPath: pathOf(metadataEndpoint, "metadataEndpoint"),
    scopesSupported: config.scopesSupported ?? [],
    accessTokenLifetimeSeconds:
      config.accessTokenLifetimeSeconds ??
      DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
    authorizationCodeLifetimeSeconds:
      config.authorizationCodeLifetimeSeconds ??
      DEFAULT_AUTHORIZATION_CODE_LIFETIME_SECONDS,
    redirectUriPolicy: config.redirectUriPolicy ?? sameOriginRedirect,
    approveAuthorization: config.approveAuthorization,
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
