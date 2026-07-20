/**
 * Configuration, the declared Cloudflare `Env` fragment, and config resolution
 * for `@dwk/webauthn`.
 *
 * Per the composition contract the package never reads the global environment
 * directly: the relying party id, expected origins, accepted algorithms, and
 * TTLs are all passed into {@link createWebAuthn}, so the handler can be
 * instantiated multiple times and unit-tested in isolation. The only runtime
 * coupling is the per-relying-party Durable Object namespace, and a missing
 * binding fails loudly at startup.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import { DEFAULT_COSE_ALGORITHMS } from "./cose.js";
import type { WebAuthnObject } from "./rp.js";

/** Cloudflare bindings required by the WebAuthn handler and Durable Object. */
export interface WebAuthnEnv {
  /**
   * Durable Object namespace for the per-relying-party class
   * ({@link WebAuthnObject}). It owns short-TTL challenge state and the
   * credential records — both strongly consistent, never KV (staleness in
   * either is a security bug).
   */
  readonly WEBAUTHN: DurableObjectNamespace<WebAuthnObject>;
}

/** Configuration passed to {@link createWebAuthn}. */
export interface WebAuthnConfig {
  /**
   * The relying party id: the effective domain credentials are scoped to, e.g.
   * `example.com`. MUST be a registrable suffix of every accepted origin's
   * host. The authenticator hashes this into `rpIdHash`.
   */
  readonly rpId: string;

  /** Human-readable relying party name shown in the authenticator UI. */
  readonly rpName: string;

  /**
   * Acceptable client origin(s), e.g. `https://example.com`. The browser puts
   * the ceremony origin in `clientDataJSON`; it must match one of these exactly.
   */
  readonly origin: string | readonly string[];

  /**
   * Accepted COSE signature algorithm identifiers, most-preferred first, offered
   * as `pubKeyCredParams`. Defaults to `[-7, -257]` (ES256, RS256).
   */
  readonly algorithms?: readonly number[];

  /** Challenge lifetime in seconds. Defaults to 300 (5 minutes). */
  readonly challengeTtlSeconds?: number;

  /** Ceremony timeout in milliseconds advertised to the client. Defaults to 60000. */
  readonly timeoutMs?: number;

  /**
   * User-verification requirement for both ceremonies. `"required"` additionally
   * makes the verifier reject an assertion whose UV flag is unset. Defaults to
   * `"preferred"`.
   */
  readonly userVerification?: UserVerificationRequirement;

  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;

  /**
   * Per-operation authorization hook, consulted by the front door before a
   * ceremony reaches the Durable Object. Return `false` to reject with `401`.
   *
   * **You almost certainly need this to gate registration.** `register/options`
   * and `register/verify` bind a passkey to a caller-supplied `user.id`; if they
   * are reachable unauthenticated, anyone can register their own authenticator
   * against another user's id and then authenticate as that user — account
   * takeover. Require an authenticated session for the `register/*` operations
   * (e.g. `authorize: (op, req) => op.startsWith("authenticate/") || hasSession(req)`).
   * The default is allow-all, matching `@dwk/vc`, so the composing front door
   * owns this decision — but leaving registration open is a footgun.
   */
  readonly authorize?: WebAuthnAuthorize;

  /** Logger for ceremony outcomes; defaults to a no-op. */
  readonly logger?: Logger;

  /** Metrics sink for ceremony outcomes; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/**
 * Authorization hook: decide whether a ceremony operation may proceed for this
 * request. Runs in the front door (not the DO), so it sees the original request
 * (cookies, `Authorization`, …). Returning `false` yields `401`.
 */
export type WebAuthnAuthorize = (
  operation: WebAuthnOperation,
  request: Request,
) => boolean | Promise<boolean>;

/** WebAuthn user-verification requirement values. */
export type UserVerificationRequirement =
  "required" | "preferred" | "discouraged";

/** Fully-resolved configuration with defaults applied. */
export interface ResolvedConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly algorithms: readonly number[];
  readonly challengeTtlSeconds: number;
  readonly timeoutMs: number;
  readonly userVerification: UserVerificationRequirement;
  readonly now: () => number;
  readonly authorize: WebAuthnAuthorize;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * The serializable subset of resolved config the front door forwards to the
 * Durable Object (which cannot receive the injected logger/metrics/clock).
 */
export interface ForwardedConfig {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: readonly string[];
  readonly algorithms: readonly number[];
  readonly challengeTtlSeconds: number;
  readonly timeoutMs: number;
  readonly userVerification: UserVerificationRequirement;
}

/** Internal headers the trusted front door uses to drive the Durable Object. */
export const INTERNAL_HEADERS = {
  /** Which ceremony step to run (see {@link WebAuthnOperation}). */
  op: "x-webauthn-op",
  /** JSON-encoded {@link ForwardedConfig}. */
  config: "x-webauthn-config",
  /** Current time (epoch ms) from the injected clock, for TTL decisions. */
  now: "x-webauthn-now",
  /** DO→front-door: the ceremony outcome event name, logged then stripped. */
  event: "x-webauthn-event",
  /** DO→front-door: a stable failure reason when the ceremony was rejected. */
  reason: "x-webauthn-reason",
} as const;

/** The four ceremony steps the handler routes. */
export type WebAuthnOperation =
  | "register/options"
  | "register/verify"
  | "authenticate/options"
  | "authenticate/verify";

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Apply defaults and derive values from raw {@link WebAuthnConfig}. */
export function resolveConfig(config: WebAuthnConfig): ResolvedConfig {
  if (!config.rpId) throw new Error("@dwk/webauthn: `rpId` is required");
  if (!config.rpName) throw new Error("@dwk/webauthn: `rpName` is required");

  const origins =
    typeof config.origin === "string" ? [config.origin] : [...config.origin];
  if (origins.length === 0) {
    throw new Error("@dwk/webauthn: at least one `origin` is required");
  }

  const algorithms =
    config.algorithms === undefined
      ? [...DEFAULT_COSE_ALGORITHMS]
      : [...config.algorithms];
  if (algorithms.length === 0) {
    throw new Error("@dwk/webauthn: at least one algorithm is required");
  }

  return {
    rpId: config.rpId,
    rpName: config.rpName,
    origins,
    algorithms,
    challengeTtlSeconds:
      config.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userVerification: config.userVerification ?? "preferred",
    now: config.now ?? (() => Date.now()),
    // Default allow-all (mirrors @dwk/vc); the composing front door is expected
    // to supply a hook that gates the `register/*` operations. See the field
    // doc on `WebAuthnConfig.authorize`.
    authorize: config.authorize ?? (() => true),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}

/** Project the resolved config to the serializable subset forwarded to the DO. */
export function forwardedConfig(config: ResolvedConfig): ForwardedConfig {
  return {
    rpId: config.rpId,
    rpName: config.rpName,
    origins: config.origins,
    algorithms: config.algorithms,
    challengeTtlSeconds: config.challengeTtlSeconds,
    timeoutMs: config.timeoutMs,
    userVerification: config.userVerification,
  };
}
