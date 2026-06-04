/**
 * NodeInfo discovery documents for `@dwk/activitypub`.
 *
 * NodeInfo lets a peer learn what software a domain runs. Both documents are
 * **largely static** — static enough for a generator like Anglesite to emit —
 * with only the live `usage` counts being dynamic. This module builds the
 * `/.well-known/nodeinfo` discovery pointer and the `nodeinfo/2.1` document from
 * plain data; the consumer decides whether to fill in live counts (from the DO)
 * or omit them.
 */

import type { JsonValue } from "./as2";

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

/**
 * Build the `/.well-known/nodeinfo` discovery document: a single `links` entry
 * pointing at the `nodeinfo/2.1` document under `baseUrl`.
 */
export function buildNodeInfoDiscovery(
  baseUrl: string,
): Record<string, JsonValue> {
  return {
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
        href: `${baseUrl}/nodeinfo/2.1`,
      },
    ],
  };
}

/**
 * Build the `nodeinfo/2.1` document. `protocols` is fixed to `activitypub`;
 * `usage` is included only when counts are supplied (a deployment that does not
 * want to wake the DO for live numbers omits them).
 */
export function buildNodeInfo21(
  software: SoftwareInfo,
  usage: UsageCounts = {},
): Record<string, JsonValue> {
  const doc: Record<string, JsonValue> = {
    version: "2.1",
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
