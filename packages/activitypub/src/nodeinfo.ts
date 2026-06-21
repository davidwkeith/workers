/**
 * NodeInfo discovery documents for `@dwk/activitypub`.
 *
 * NodeInfo lets a peer learn what software a domain runs. The documents are
 * **largely static** — static enough for a generator like Anglesite to emit —
 * with only the live `usage` counts being dynamic. This module builds the
 * `/.well-known/nodeinfo` discovery pointer (advertising both the 2.0 and 2.1
 * schemas, since many consumers still request 2.0) and the matching `nodeinfo`
 * documents from plain data; the consumer decides whether to fill in live counts
 * (from the DO) or omit them.
 */

import type { JsonValue } from "./as2.js";

/** Identifies the running software in the NodeInfo `software` block. */
export interface SoftwareInfo {
  readonly name: string;
  readonly version: string;
}

/** Dynamic usage counts; omitted entirely when not supplied. */
export interface UsageCounts {
  readonly users?: number;
  readonly localPosts?: number;
}

/** Schema rel for the NodeInfo 2.0 document. */
const NODEINFO_REL_20 = "http://nodeinfo.diaspora.software/ns/schema/2.0";
/** Schema rel for the NodeInfo 2.1 document. */
const NODEINFO_REL_21 = "http://nodeinfo.diaspora.software/ns/schema/2.1";

/**
 * Build the `/.well-known/nodeinfo` discovery document. NodeInfo allows multiple
 * `links` entries, so both the 2.0 and 2.1 documents are advertised: many
 * consumers still request 2.0, and listing both maximizes interop.
 */
export function buildNodeInfoDiscovery(
  baseUrl: string,
): Record<string, JsonValue> {
  return {
    links: [
      { rel: NODEINFO_REL_20, href: `${baseUrl}/nodeinfo/2.0` },
      { rel: NODEINFO_REL_21, href: `${baseUrl}/nodeinfo/2.1` },
    ],
  };
}

/**
 * Build a NodeInfo document for the given schema `version`. `protocols` is fixed
 * to `activitypub`; `usage` is included only when counts are supplied (a
 * deployment that does not want to wake the DO for live numbers omits them). The
 * 2.0 and 2.1 schemas agree on every field we emit, so the only difference is
 * the `version` string.
 */
function buildNodeInfo(
  version: "2.0" | "2.1",
  software: SoftwareInfo,
  usage: UsageCounts,
): Record<string, JsonValue> {
  const doc: Record<string, JsonValue> = {
    version,
    software: { name: software.name, version: software.version },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    metadata: {},
  };
  if (usage.users !== undefined || usage.localPosts !== undefined) {
    doc.usage = {
      users: { total: usage.users ?? 0 },
      localPosts: usage.localPosts ?? 0,
    };
  }
  return doc;
}

/** Build the `nodeinfo/2.0` document (see {@link buildNodeInfo}). */
export function buildNodeInfo20(
  software: SoftwareInfo,
  usage: UsageCounts = {},
): Record<string, JsonValue> {
  return buildNodeInfo("2.0", software, usage);
}

/** Build the `nodeinfo/2.1` document (see {@link buildNodeInfo}). */
export function buildNodeInfo21(
  software: SoftwareInfo,
  usage: UsageCounts = {},
): Record<string, JsonValue> {
  return buildNodeInfo("2.1", software, usage);
}
