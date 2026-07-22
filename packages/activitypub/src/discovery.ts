/**
 * SSRF-guarded fediverse discovery for `@dwk/activitypub` (§2.4): resolve a
 * handle (`!birding@lemmy.ml`, `user@host`, …) to its actor IRI via
 * `@dwk/webfinger`'s JRD helper, and dereference an actor document — both
 * through the same public-HTTPS guard outbound delivery uses, since hosts
 * come from untrusted input. Shared by the front door's publish path and the
 * MCP tool contributions.
 *
 * @see spec/fediverse-interop.md §2.4
 */

import { resolveHandle } from "@dwk/webfinger";

import { assertPublicHttpsTarget } from "./delivery.js";
import { createTimeoutSignal } from "./timeout.js";

/** Whether a string looks like a handle rather than an IRI. */
export function isHandleShaped(value: string): boolean {
  return !/^https?:\/\//i.test(value);
}

/** Wrap a fetch so every request target passes the outbound SSRF guard. */
export function guardedFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    assertPublicHttpsTarget(url);
    return fetchImpl(input, init);
  };
}

/**
 * Resolve a handle to its `https:` actor IRI, or `null`. The WebFinger
 * lookup runs through the SSRF guard; a guard rejection (private host,
 * non-HTTPS) resolves to `null` rather than throwing.
 */
export async function resolveHandleGuarded(
  handle: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let actor: string | null;
  try {
    actor = await resolveHandle(handle, { fetch: guardedFetch(fetchImpl) });
  } catch {
    return null;
  }
  return actor !== null && /^https:\/\//i.test(actor) ? actor : null;
}

/** A dereferenced actor's identity facts, for `activitypub_resolve`. */
export interface ResolvedActor {
  readonly id: string;
  /** AS2 actor type (`Person`, `Group`, `Service`, …) when the doc names one. */
  readonly type?: string;
  readonly inbox?: string;
  readonly preferredUsername?: string;
  readonly name?: string;
}

/** Ceiling on an untrusted actor document's size (bytes). */
const MAX_ACTOR_DOC_BYTES = 1024 * 1024;

/**
 * Read a response body as JSON with a hard byte ceiling, streaming so a
 * remote that omits (or lies about) `content-length` still cannot exceed the
 * cap. `null` on over-cap, unreadable, or unparseable bodies.
 */
export async function readJsonCapped(
  response: Response,
  cap: number,
): Promise<unknown | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** Fetch an actor document (AS2, guarded, bounded) and read its identity facts. */
export async function fetchActorGuarded(
  iri: string,
  fetchImpl: typeof fetch,
): Promise<ResolvedActor | null> {
  let response: Response;
  const timeout = createTimeoutSignal(10_000);
  try {
    response = await guardedFetch(fetchImpl)(iri, {
      headers: { accept: "application/activity+json" },
      signal: timeout.signal,
    });
  } catch {
    return null;
  } finally {
    timeout.cancel();
  }
  if (!response.ok) return null;
  const doc = await readJsonCapped(response, MAX_ACTOR_DOC_BYTES);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  const actor: {
    id: string;
    type?: string;
    inbox?: string;
    preferredUsername?: string;
    name?: string;
  } = { id: record.id };
  if (typeof record.type === "string") actor.type = record.type;
  if (typeof record.inbox === "string") actor.inbox = record.inbox;
  if (typeof record.preferredUsername === "string") {
    actor.preferredUsername = record.preferredUsername;
  }
  if (typeof record.name === "string") actor.name = record.name;
  return actor;
}

/**
 * A display handle for a followed community, derived heuristically from its
 * IRI (`https://lemmy.ml/c/birding` → `!birding@lemmy.ml`). Display-only —
 * the IRI stays the stable identifier.
 */
export function communityDisplayHandle(iri: string): string {
  try {
    const url = new URL(iri);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last) return `!${decodeURIComponent(last)}@${url.hostname}`;
    return iri;
  } catch {
    return iri;
  }
}
