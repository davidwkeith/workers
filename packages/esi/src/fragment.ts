/**
 * Fragment fetcher — resolves a single `esi:include` token to its spliced-in
 * text, per the onerror/alt rules in
 * `docs/superpowers/specs/2026-07-13-esi-design.md`.
 */

import {
  safeFetch,
  readBodyCapped,
  MAX_BODY_BYTES,
  type FetchLike,
  type SafeFetchOptions,
} from "@dwk/safe-fetch";
import { noopLogger, type Logger, type Metrics } from "@dwk/log";
import type { EsiToken } from "./tokenize.js";

export interface FragmentFetchOptions {
  /** Base URL to resolve a relative src/alt against before validating it
   *  (`new URL(src, baseUrl)`) — see the design doc's API section. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly safeFetchOptions?: SafeFetchOptions;
  readonly maxFragmentBytes?: number;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

function resolveUrl(raw: string, baseUrl: string | undefined): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchFragmentBody(
  resolvedUrl: string,
  fetchFn: FetchLike,
  safeFetchOptions: SafeFetchOptions | undefined,
  maxFragmentBytes: number,
): Promise<string | null> {
  try {
    const { response } = await safeFetch(
      fetchFn,
      resolvedUrl,
      { method: "GET" },
      safeFetchOptions,
    );
    if (!response.ok) {
      return null;
    }
    return await readBodyCapped(response, maxFragmentBytes);
  } catch {
    return null;
  }
}

/** Resolves an include token to its spliced-in text. Never throws — a
 *  failure of any kind resolves to "" per the design doc's onerror/alt
 *  rules, after trying `alt` when applicable. */
export async function resolveFragment(
  token: Extract<EsiToken, { kind: "include" }>,
  options: FragmentFetchOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const logger = options.logger ?? noopLogger;
  const maxFragmentBytes = options.maxFragmentBytes ?? MAX_BODY_BYTES;

  const primaryUrl = resolveUrl(token.src, options.baseUrl);
  const primaryBody =
    primaryUrl === null
      ? null
      : await fetchFragmentBody(
          primaryUrl,
          fetchFn,
          options.safeFetchOptions,
          maxFragmentBytes,
        );
  if (primaryBody !== null) {
    return primaryBody;
  }

  if (token.onerror === "continue") {
    logger.debug("esi.fragment.failed", { src: token.src });
    return "";
  }

  if (token.alt !== undefined) {
    const altUrl = resolveUrl(token.alt, options.baseUrl);
    const altBody =
      altUrl === null
        ? null
        : await fetchFragmentBody(
            altUrl,
            fetchFn,
            options.safeFetchOptions,
            maxFragmentBytes,
          );
    if (altBody !== null) {
      return altBody;
    }
    logger.warn("esi.fragment.failed", { src: token.src, alt: token.alt });
    return "";
  }

  logger.warn("esi.fragment.failed", { src: token.src });
  return "";
}
