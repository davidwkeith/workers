/**
 * A thin client for the public [PLC directory](https://web.plc.directory) HTTP
 * API — the one external dependency a `did:plc` account takes on.
 *
 * The directory is an append-only operation log keyed by DID. This client speaks
 * the three calls the PDS needs: **submit** an operation (`POST /:did`, the path
 * that registers a fresh `did:plc` or rotates an existing one), **resolve** a DID
 * to its document (`GET /:did`), and read its current **data** state
 * (`GET /:did/data`, what an inbound migration inspects).
 *
 * `fetch` is **injected** (defaulting to the global) so the client unit-tests
 * with a fake transport and the DO can wire a configurable directory URL —
 * keeping the external dependency at arm's length, never the default path.
 */

import type { SignedPlcOperation } from "./plc.js";

/** The minimal `fetch` shape this client needs (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** The canonical PLC directory; override per-deployment / in tests. */
export const DEFAULT_PLC_DIRECTORY = "https://plc.directory";

/** Options for a directory call. */
export interface PlcDirectoryOptions {
  /** Directory base URL. Defaults to {@link DEFAULT_PLC_DIRECTORY}. */
  readonly directoryUrl?: string;
  /** Injected transport. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

function resolve(options: PlcDirectoryOptions): {
  base: string;
  fetchImpl: FetchLike;
} {
  const raw = options.directoryUrl ?? DEFAULT_PLC_DIRECTORY;
  const base = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  // A did:plc id is `[a-z2-7]` after the method prefix, so the two colons are the
  // only reserved characters — and they are legal, unencoded, in a path segment
  // (RFC 3986), which is exactly what the directory expects.
  return { base, fetchImpl: options.fetchImpl ?? (fetch as FetchLike) };
}

/**
 * Submit a signed operation to the directory (`POST /:did`). Registers a fresh
 * `did:plc` (genesis) or appends a rotation/update. Throws on a non-2xx
 * response, surfacing the directory's error body.
 */
export async function submitPlcOperation(
  did: string,
  op: SignedPlcOperation,
  options: PlcDirectoryOptions = {},
): Promise<void> {
  const { base, fetchImpl } = resolve(options);
  const res = await fetchImpl(`${base}/${did}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `plc: directory rejected the operation for ${did} (${res.status})${
        body ? `: ${body}` : ""
      }`,
    );
  }
}

/**
 * Resolve a DID to its document (`GET /:did`). Returns the parsed JSON, or
 * `null` if the directory has no record of the DID (404).
 */
export async function resolvePlcDid(
  did: string,
  options: PlcDirectoryOptions = {},
): Promise<unknown | null> {
  const { base, fetchImpl } = resolve(options);
  const res = await fetchImpl(`${base}/${did}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`plc: directory resolve failed for ${did} (${res.status})`);
  }
  return res.json();
}

/**
 * Fetch a DID's current operation **data** state (`GET /:did/data`) — the
 * rotation keys, verification methods, also-known-as, and services an inbound
 * migration needs to read. `null` if unknown (404).
 */
export async function fetchPlcData(
  did: string,
  options: PlcDirectoryOptions = {},
): Promise<unknown | null> {
  const { base, fetchImpl } = resolve(options);
  const res = await fetchImpl(`${base}/${did}/data`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `plc: directory data fetch failed for ${did} (${res.status})`,
    );
  }
  return res.json();
}
