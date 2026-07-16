/**
 * DID-document resolution: recovering an account's published signing key from
 * its DID document, across both methods this PDS supports.
 *
 * Inbound migration needs this to verify that a repository CAR really was signed
 * by the account it claims: the source account's signing key lives in its DID
 * document (in the PLC directory for `did:plc`, or at the origin for `did:web`),
 * advertised as a `Multikey`. `fetch` is injected so this unit-tests with a fake
 * transport and the Durable Object can pass a configured directory URL.
 */

import { safeFetchJson, SsrfError } from "@dwk/safe-fetch";

import { decodeMultikey, type DecodedMultikey } from "./crypto.js";
import { resolvePlcDid, type FetchLike } from "./plc-directory.js";

interface VerificationMethod {
  readonly id: string;
  readonly type?: string;
  readonly publicKeyMultibase?: string;
}

interface DidDocument {
  readonly verificationMethod?: VerificationMethod[];
}

/** Options for DID resolution. */
export interface ResolveOptions {
  /** PLC directory base URL (for `did:plc`). */
  readonly plcDirectoryUrl?: string;
  /** Injected transport. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /**
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:2582"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
}

/** Resolve a DID to its document (`did:web` at the origin, `did:plc` via the directory). */
export async function resolveDidDocument(
  did: string,
  options: ResolveOptions = {},
): Promise<DidDocument> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  if (did.startsWith("did:web:")) {
    // did:web per spec: colon-separated id, first segment is host[%3Aport], any
    // further segments are a percent-decoded path. Host form →
    // /.well-known/did.json; path form → /<path>/did.json. A source PDS may use
    // either, so inbound migration must resolve both.
    const segments = did.slice("did:web:".length).split(":");
    const host = segments[0]!.replace(/%3A/gi, ":");
    const path = segments.slice(1).map(decodeURIComponent).join("/");
    const url = path
      ? `https://${host}/${path}/did.json`
      : `https://${host}/.well-known/did.json`;
    try {
      return (await safeFetchJson(
        fetchImpl,
        url,
        { headers: { accept: "application/did+json, application/json" } },
        {
          allowedSchemes: ["https:"],
          logEvent: "atproto-pds.ssrf.blocked",
          allowedHosts: options.fetchAllowedHosts,
        },
      )) as DidDocument;
    } catch (err) {
      if (err instanceof SsrfError) throw err;
      throw new Error(
        `resolve: did:web document fetch failed for ${did} (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
  }
  if (did.startsWith("did:plc:")) {
    const doc = await resolvePlcDid(did, {
      directoryUrl: options.plcDirectoryUrl,
      fetchImpl,
      fetchAllowedHosts: options.fetchAllowedHosts,
    });
    if (!doc) throw new Error(`resolve: did:plc ${did} not found in directory`);
    return doc as DidDocument;
  }
  throw new Error(`resolve: unsupported DID method for ${did}`);
}

/**
 * Resolve the account's repository signing key from its DID document — the
 * `#atproto` verification method (or the first one), decoded from its Multikey.
 */
export async function resolveSigningKey(
  did: string,
  options: ResolveOptions = {},
): Promise<DecodedMultikey> {
  const doc = await resolveDidDocument(did, options);
  const vm =
    doc.verificationMethod?.find((m) => m.id.endsWith("#atproto")) ??
    doc.verificationMethod?.[0];
  if (!vm?.publicKeyMultibase) {
    throw new Error(`resolve: no signing key in the DID document for ${did}`);
  }
  return decodeMultikey(vm.publicKeyMultibase);
}
