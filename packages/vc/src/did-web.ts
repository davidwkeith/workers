/**
 * `did:web` ↔ URL mapping, DID-document construction, and verification-method
 * resolution.
 *
 * The DID document itself (`/.well-known/did.json`) is a static artifact a static
 * host can serve — {@link buildDidDocument} produces it — so this package does
 * not need a Worker to *resolve* a DID. The Worker side uses
 * {@link createDidWebResolver} during VC verification to fetch a credential
 * issuer's DID document and locate the verification key referenced by a proof.
 *
 * Method/URL mapping follows the did:web rules: the first colon-separated
 * component is the host (with a `%3A`-encoded port), remaining components are
 * path segments, and a bare host resolves under `/.well-known/`.
 *
 * @see https://w3c-ccg.github.io/did-method-web/
 */

import type { JsonObject, VerificationMethod } from "./data-integrity.js";

const DID_WEB_PREFIX = "did:web:";

/** The default did:web context documents emitted by {@link buildDidDocument}. */
export const DID_CONTEXT_V1 = "https://www.w3.org/ns/did/v1";
export const MULTIKEY_CONTEXT_V1 = "https://w3id.org/security/multikey/v1";
export const JWK_CONTEXT_V1 = "https://w3id.org/security/jwk/v1";

/**
 * Convert a `did:web` identifier to the URL of its DID document. Throws if the
 * input is not a `did:web` identifier.
 */
export function didWebToUrl(did: string): string {
  if (!did.startsWith(DID_WEB_PREFIX)) {
    throw new Error(`@dwk/vc: "${did}" is not a did:web identifier`);
  }
  const components = did.slice(DID_WEB_PREFIX.length).split(":");
  const host = components[0];
  if (host === undefined || host.length === 0) {
    throw new Error(`@dwk/vc: did:web identifier "${did}" has no host`);
  }
  const authority = decodeURIComponent(host);
  const segments = components.slice(1).map((segment) => {
    if (segment.length === 0) {
      throw new Error(
        `@dwk/vc: did:web identifier "${did}" has an empty path segment`,
      );
    }
    const decoded = decodeURIComponent(segment);
    // Reject `.`/`..` so a crafted identifier cannot traverse out of its path
    // when the URL is built and fetched.
    if (decoded === "." || decoded === "..") {
      throw new Error(
        `@dwk/vc: did:web identifier "${did}" has an invalid path segment "${decoded}"`,
      );
    }
    return decoded;
  });
  const path =
    segments.length === 0
      ? "/.well-known/did.json"
      : `/${segments.join("/")}/did.json`;
  return `https://${authority}${path}`;
}

/**
 * Derive the `did:web` identifier a URL (or host) would publish. A bare origin
 * (or one whose path is `/.well-known/did.json`) maps to `did:web:<host>`; a
 * deeper path maps its segments to colon-separated components.
 */
export function urlToDidWeb(input: string): string {
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  const host = url.host; // includes a non-default port
  const encodedHost = host.replace(/:/g, "%3A");

  let pathname = url.pathname;
  if (pathname.endsWith("/did.json")) {
    pathname = pathname.slice(0, -"/did.json".length);
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    (segments.length === 1 && segments[0] === ".well-known")
  ) {
    return `${DID_WEB_PREFIX}${encodedHost}`;
  }
  const encoded = segments.map((segment) => encodeURIComponent(segment));
  return `${DID_WEB_PREFIX}${encodedHost}:${encoded.join(":")}`;
}

/** Input describing one verification method to publish in a DID document. */
export interface VerificationMethodInput {
  /** Method id. A bare fragment (`#key-0`) is resolved against the DID. */
  readonly id: string;
  /** Method type. Defaults to `"Multikey"` (or `"JsonWebKey"` for a JWK). */
  readonly type?: string;
  readonly publicKeyMultibase?: string;
  readonly publicKeyJwk?: JsonWebKey;
}

/** Verification relationships a method can be referenced by. */
export interface VerificationRelationships {
  /** Reference under `assertionMethod` (issuing credentials). Default `true`. */
  readonly assertionMethod?: boolean;
  /** Reference under `authentication`. Default `false`. */
  readonly authentication?: boolean;
}

/** Options for {@link buildDidDocument}. */
export interface BuildDidDocumentOptions {
  readonly did: string;
  readonly verificationMethods: readonly VerificationMethodInput[];
  /** Relationships applied to every supplied method. */
  readonly relationships?: VerificationRelationships;
  /** Optional `alsoKnownAs` identifiers (e.g. an `https:` WebID). */
  readonly alsoKnownAs?: readonly string[];
}

function absoluteId(did: string, id: string): string {
  return id.startsWith("#") ? `${did}${id}` : id;
}

/**
 * Build a `did:web` DID document from public verification methods. Emits the
 * DID, Multikey, and (when a JWK method is present) JWK context documents, the
 * `verificationMethod` array, and the requested verification relationships
 * (defaulting to `assertionMethod`). Suitable for serialization to
 * `/.well-known/did.json`.
 */
export function buildDidDocument(options: BuildDidDocumentOptions): JsonObject {
  const { did } = options;
  if (!did.startsWith(DID_WEB_PREFIX)) {
    throw new Error(`@dwk/vc: "${did}" is not a did:web identifier`);
  }
  if (options.verificationMethods.length === 0) {
    throw new Error(
      "@dwk/vc: a DID document needs at least one verification method",
    );
  }

  let hasJwk = false;
  const methods = options.verificationMethods.map((input) => {
    const id = absoluteId(did, input.id);
    const method: JsonObject = {
      id,
      controller: did,
    };
    if (input.publicKeyMultibase !== undefined) {
      method.type = input.type ?? "Multikey";
      method.publicKeyMultibase = input.publicKeyMultibase;
    } else if (input.publicKeyJwk !== undefined) {
      hasJwk = true;
      method.type = input.type ?? "JsonWebKey";
      method.publicKeyJwk = input.publicKeyJwk as unknown as JsonObject;
    } else {
      throw new Error(
        `@dwk/vc: verification method "${id}" needs publicKeyMultibase or publicKeyJwk`,
      );
    }
    return { id, method };
  });

  const context: string[] = [DID_CONTEXT_V1, MULTIKEY_CONTEXT_V1];
  if (hasJwk) context.push(JWK_CONTEXT_V1);

  const relationships = options.relationships ?? {};
  const ids = methods.map((m) => m.id);

  const document: JsonObject = {
    "@context": context,
    id: did,
    verificationMethod: methods.map((m) => m.method),
  };
  if (relationships.assertionMethod ?? true) document.assertionMethod = ids;
  if (relationships.authentication ?? false) document.authentication = ids;
  if (options.alsoKnownAs !== undefined && options.alsoKnownAs.length > 0) {
    document.alsoKnownAs = [...options.alsoKnownAs];
  }
  return document;
}

/**
 * Locate a verification method in a DID document by its id. A method `id` that
 * is a relative reference (`#key-0`) is resolved against the document's `id`
 * before comparison, per DID Core — foreign documents commonly use relative ids.
 */
export function findVerificationMethod(
  didDocument: JsonObject,
  id: string,
): VerificationMethod | undefined {
  const docId = typeof didDocument.id === "string" ? didDocument.id : "";
  const methods = didDocument.verificationMethod;
  if (!Array.isArray(methods)) return undefined;
  for (const entry of methods) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const entryId = (entry as JsonObject).id;
    if (typeof entryId !== "string") continue;
    const resolved = entryId.startsWith("#") ? `${docId}${entryId}` : entryId;
    if (resolved === id) {
      return entry as unknown as VerificationMethod;
    }
  }
  return undefined;
}

/** A minimal `fetch` used to retrieve DID documents. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Options for {@link createDidWebResolver}. */
export interface DidWebResolverOptions {
  /** Override the fetch implementation (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
}

/**
 * Build a {@link VerificationMethodResolver} that resolves a `did:web`
 * verification-method id by fetching the controller's DID document over HTTPS
 * and locating the referenced method. Returns `undefined` for non-`did:web`
 * ids, fetch failures, and unknown methods — verification treats that as an
 * unresolvable key rather than throwing.
 */
export function createDidWebResolver(
  options: DidWebResolverOptions = {},
): (id: string) => Promise<VerificationMethod | undefined> {
  const fetchImpl =
    options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (fetchImpl === undefined) {
    throw new Error(
      "@dwk/vc: no fetch implementation available for did:web resolution",
    );
  }

  return async (id: string) => {
    const hashIndex = id.indexOf("#");
    const did = hashIndex === -1 ? id : id.slice(0, hashIndex);
    if (!did.startsWith(DID_WEB_PREFIX)) return undefined;

    let url: string;
    try {
      url = didWebToUrl(did);
    } catch {
      return undefined;
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/did+json, application/json" },
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;

    let document: unknown;
    try {
      document = await response.json();
    } catch {
      return undefined;
    }
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document)
    ) {
      return undefined;
    }
    return findVerificationMethod(document as JsonObject, id);
  };
}
