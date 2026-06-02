/**
 * `@dwk/webmention` — synchronous receiver validation.
 *
 * The Webmention receiver MUST validate `source` and `target` up front, before
 * returning `202 Accepted` and before any network work, to reject malformed or
 * foreign requests and prevent queue-exhaustion / spam. This module holds that
 * pure check: plain strings in, a decision out. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

/** Stable, locale-independent codes for an up-front validation failure. */
export type WebmentionValidationError =
  | "missing_source"
  | "missing_target"
  | "invalid_source"
  | "invalid_target"
  | "source_equals_target"
  | "target_not_supported";

/** Inputs to {@link validateWebmentionParams}. */
export interface ValidateParams {
  /** The `source` form field (or `null` when absent). */
  readonly source: string | null;
  /** The `target` form field (or `null` when absent). */
  readonly target: string | null;
  /** Base URL of this receiver; `target` must live under its origin. */
  readonly baseUrl: string;
  /**
   * Additional hostnames (besides `baseUrl`'s) that this receiver controls.
   * Useful when one Worker fronts several domains.
   */
  readonly allowedHosts?: readonly string[];
}

/** Result of {@link validateWebmentionParams}. */
export type ValidationResult =
  | { readonly ok: true; readonly source: string; readonly target: string }
  | { readonly ok: false; readonly error: WebmentionValidationError };

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return url;
}

/**
 * Validate a received `source`/`target` pair synchronously.
 *
 * Checks, in order: both fields present, both syntactically valid `http(s)`
 * URLs, `source` ≠ `target`, and `target` is a resource under this receiver's
 * control (its host matches `baseUrl` or `allowedHosts`). Never performs I/O.
 *
 * @returns `{ ok: true, source, target }` with normalized URLs on success, or
 * `{ ok: false, error }` with a stable {@link WebmentionValidationError}.
 */
export function validateWebmentionParams(
  params: ValidateParams,
): ValidationResult {
  const { source, target, baseUrl, allowedHosts } = params;

  if (source === null || source === "") {
    return { ok: false, error: "missing_source" };
  }
  if (target === null || target === "") {
    return { ok: false, error: "missing_target" };
  }

  const sourceUrl = parseHttpUrl(source);
  if (sourceUrl === null) {
    return { ok: false, error: "invalid_source" };
  }
  const targetUrl = parseHttpUrl(target);
  if (targetUrl === null) {
    return { ok: false, error: "invalid_target" };
  }

  if (sourceUrl.toString() === targetUrl.toString()) {
    return { ok: false, error: "source_equals_target" };
  }

  if (!isControlledHost(targetUrl.host, baseUrl, allowedHosts)) {
    return { ok: false, error: "target_not_supported" };
  }

  return {
    ok: true,
    source: sourceUrl.toString(),
    target: targetUrl.toString(),
  };
}

function isControlledHost(
  host: string,
  baseUrl: string,
  allowedHosts: readonly string[] | undefined,
): boolean {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(baseUrl).host.toLowerCase());
  } catch {
    // A malformed baseUrl is a configuration error; fall through with no host
    // allowed so every target is rejected rather than silently accepted.
  }
  for (const entry of allowedHosts ?? []) {
    allowed.add(entry.toLowerCase());
  }
  return allowed.has(host.toLowerCase());
}
