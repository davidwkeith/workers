/**
 * ActivityStreams 2.0 vocabulary helpers for `@dwk/activitypub`.
 *
 * ActivityStreams 2.0 documents are JSON-LD, but the entire fediverse interops
 * over the **compact** form with a fixed `@context`, so this module emits and
 * parses that compact JSON shape directly rather than running a full JSON-LD
 * processor. (Whether `@dwk/rdf`'s v1 JSON-LD subset covers the AS2 context is
 * an open question — see `spec/open-questions.md` §4 — so v1 stays on the
 * compact form Mastodon and friends actually speak.)
 *
 * Pure data: every function takes plain values and returns plain JSON objects,
 * so the vocabulary is unit-testable without a Workers runtime or any binding.
 */

/** The ActivityStreams 2.0 namespace IRI. */
export const AS2_NS = "https://www.w3.org/ns/activitystreams";

/** The W3C security vocabulary namespace (carries `publicKey`). */
export const SECURITY_NS = "https://w3id.org/security/v1";

/** The special "public" collection that marks an activity world-readable. */
export const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";

/**
 * The `@context` an actor document advertises: the AS2 base plus the security
 * vocabulary (so `publicKey` resolves) and the handful of property aliases
 * (`manuallyApprovesFollowers`, `discoverable`) the fediverse expects.
 */
export const ACTOR_CONTEXT: readonly unknown[] = [
  AS2_NS,
  SECURITY_NS,
  {
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    toot: "http://joinmastodon.org/ns#",
    discoverable: "toot:discoverable",
  },
];

/** Media type for an ActivityStreams 2.0 / ActivityPub document. */
export const AS2_CONTENT_TYPE = "application/activity+json; charset=utf-8";

/**
 * The JSON-LD profile variant of AS2. A strict client may content-negotiate for
 * `application/ld+json` carrying the ActivityStreams profile rather than the
 * `application/activity+json` alias the fediverse speaks; both name the same
 * document (§3.2).
 */
export const AS2_LD_CONTENT_TYPE =
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';

/**
 * The media types a federation peer uses to request AS2. A `GET` whose `Accept`
 * names any of these (or the matching `profile`) wants the activity JSON rather
 * than an HTML profile page.
 */
const AS2_ACCEPT_TOKENS = [
  "application/activity+json",
  "application/ld+json",
  'profile="https://www.w3.org/ns/activitystreams"',
];

/** Whether an `Accept` header is asking for the ActivityStreams representation. */
export function wantsActivityJson(accept: string | null): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return AS2_ACCEPT_TOKENS.some((token) => lower.includes(token));
}

/**
 * Pick the AS2 media type to serve for a given `Accept` (§3.2 content
 * negotiation). A peer that asks specifically for the JSON-LD profile variant
 * (`application/ld+json`, without also naming `application/activity+json`) gets
 * {@link AS2_LD_CONTENT_TYPE}; everyone else — plain browsers, and the
 * `application/activity+json` alias the fediverse speaks — gets
 * {@link AS2_CONTENT_TYPE}.
 */
export function as2ContentType(accept: string | null): string {
  if (accept && wantsActivityJson(accept)) {
    const lower = accept.toLowerCase();
    if (
      lower.includes("application/ld+json") &&
      !lower.includes("application/activity+json")
    ) {
      return AS2_LD_CONTENT_TYPE;
    }
  }
  return AS2_CONTENT_TYPE;
}

/** A minimal JSON value type for AS2 documents. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A parsed ActivityStreams object/activity (compact JSON). */
export interface ActivityObject {
  readonly id?: string;
  readonly type?: string;
  readonly actor?: JsonValue;
  readonly object?: JsonValue;
  readonly target?: JsonValue;
  readonly to?: JsonValue;
  readonly cc?: JsonValue;
  readonly [key: string]: JsonValue | undefined;
}

/** The derived IRI set that identifies one actor and its collections. */
export interface ActorIris {
  readonly id: string;
  readonly inbox: string;
  readonly outbox: string;
  readonly followers: string;
  readonly following: string;
  readonly keyId: string;
}

/** The human-facing profile fields of an actor. */
export interface ActorProfile {
  /** `preferredUsername` — the local part of the `acct:` handle. */
  readonly username: string;
  /** Display name; defaults to {@link username}. */
  readonly name?: string;
  /** Short bio rendered as `summary` (may contain HTML). */
  readonly summary?: string;
  /** Avatar image URL, surfaced as the actor `icon`. */
  readonly icon?: string;
  /** Whether follows require manual approval. Defaults to `false` (auto-accept). */
  readonly manuallyApprovesFollowers?: boolean;
  /** Whether the actor opts into discovery/search (Mastodon `toot:discoverable`). */
  readonly discoverable?: boolean;
}

/** Optional extras woven into the actor document. */
export interface ActorDocumentOptions {
  /**
   * The instance-level shared inbox IRI, advertised under `endpoints` (§4.1 /
   * §7.1.3) so large peers can batch-deliver to this actor. Omitted entirely
   * when the deployment does not serve one.
   */
  readonly sharedInbox?: string;
}

/**
 * Build the `Person` actor document served at the actor IRI. The public key is
 * embedded inline (PEM) under the security vocabulary so verifiers can resolve
 * `keyId` without a second fetch, exactly as Mastodon publishes it.
 */
export function buildActorDocument(
  iris: ActorIris,
  profile: ActorProfile,
  publicKeyPem: string,
  options: ActorDocumentOptions = {},
): Record<string, JsonValue> {
  const doc: Record<string, JsonValue> = {
    "@context": ACTOR_CONTEXT as JsonValue,
    id: iris.id,
    type: "Person",
    preferredUsername: profile.username,
    name: profile.name ?? profile.username,
    inbox: iris.inbox,
    outbox: iris.outbox,
    followers: iris.followers,
    following: iris.following,
    manuallyApprovesFollowers: profile.manuallyApprovesFollowers ?? false,
    discoverable: profile.discoverable ?? true,
    publicKey: {
      id: iris.keyId,
      owner: iris.id,
      publicKeyPem,
    },
  };
  if (profile.summary !== undefined) doc.summary = profile.summary;
  if (profile.icon !== undefined) {
    doc.icon = { type: "Image", url: profile.icon };
  }
  if (options.sharedInbox !== undefined) {
    doc.endpoints = { sharedInbox: options.sharedInbox };
  }
  return doc;
}

/**
 * Build a paged `OrderedCollection` head document — the response to a bare
 * collection `GET` (no `page` parameter). It advertises the total count and the
 * `first`/`last` page links; the members live on the pages.
 */
export function buildCollection(
  id: string,
  totalItems: number,
  pageSize: number,
): Record<string, JsonValue> {
  const doc: Record<string, JsonValue> = {
    "@context": AS2_NS,
    id,
    type: "OrderedCollection",
    totalItems,
  };
  if (totalItems > 0) {
    doc.first = `${id}?page=1`;
    doc.last = `${id}?page=${Math.max(1, Math.ceil(totalItems / pageSize))}`;
  }
  return doc;
}

/**
 * Build one `OrderedCollectionPage` of members. `next` is present only when a
 * further page exists, so a crawler walks `first → next → …` until it stops.
 */
export function buildCollectionPage(
  collectionId: string,
  page: number,
  pageSize: number,
  totalItems: number,
  items: readonly JsonValue[],
): Record<string, JsonValue> {
  const doc: Record<string, JsonValue> = {
    "@context": AS2_NS,
    id: `${collectionId}?page=${page}`,
    type: "OrderedCollectionPage",
    partOf: collectionId,
    totalItems,
    orderedItems: items as JsonValue,
  };
  if (page * pageSize < totalItems) {
    doc.next = `${collectionId}?page=${page + 1}`;
  }
  if (page > 1) doc.prev = `${collectionId}?page=${page - 1}`;
  return doc;
}

/** Read the `id` of an activity's `object`, whether it is an IRI or nested object. */
export function objectId(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, JsonValue>).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** Read the `type` of an activity's `object` when it is a nested object. */
export function objectType(value: JsonValue | undefined): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as Record<string, JsonValue>).type;
    if (typeof type === "string") return type;
  }
  return undefined;
}

/** Coerce an actor reference (IRI string or embedded object) to its IRI. */
export function actorIri(value: JsonValue | undefined): string | undefined {
  return objectId(value);
}
