/**
 * Identity primitives that keep an account's identity rooted at its **own
 * domain** — the heart of the "there are no instances" model: identity is a DID
 * the user controls, hosting is a swappable service entry in its document.
 *
 * This package standardises on `did:web` (derived from the account's domain) so
 * the DID document, the handle, and the data server all live under one origin
 * the user owns — no external PLC directory required. The document advertises
 * the repository signing key as a `Multikey` and the PDS as an
 * `AtprotoPersonalDataServer` service, which is what lets any app discover where
 * the repository lives and verify its commits.
 */

import type { CborValue } from "./cbor.js";
import type { SigningCurve } from "./crypto.js";

/** Derive the `did:web` identifier for a hostname (optionally a port). */
export function didWebFromHost(host: string): string {
  // did:web encodes the colon of a host:port as %3A; a bare host is verbatim.
  return "did:web:" + host.replace(/:/g, "%3A");
}

/** A minimal DID document for an AT Protocol account served from its own domain. */
export interface DidDocumentInput {
  readonly did: string;
  readonly handle: string;
  readonly pdsEndpoint: string;
  readonly publicKeyMultibase: string;
  /** The signing curve, so the `@context` advertises the right key suite. */
  readonly curve: SigningCurve;
}

/** Build the `did:web` document advertising the handle, signing key, and PDS. */
export function buildDidDocument(input: DidDocumentInput): CborValue {
  // The verification method is a `Multikey` — self-describing via its multicodec
  // prefix — so `multikey/v1` covers either curve. Advertise the legacy
  // secp256k1-2019 suite context only for a secp256k1 key; a P-256 account (the
  // default) must not claim it, as the prior unconditional context did.
  const context = [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
  ];
  if (input.curve === "secp256k1") {
    context.push("https://w3id.org/security/suites/secp256k1-2019/v1");
  }
  return {
    "@context": context,
    id: input.did,
    alsoKnownAs: [`at://${input.handle}`],
    verificationMethod: [
      {
        id: `${input.did}#atproto`,
        type: "Multikey",
        controller: input.did,
        publicKeyMultibase: input.publicKeyMultibase,
      },
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: input.pdsEndpoint,
      },
    ],
  };
}

const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** Whether a string is a syntactically valid AT Protocol handle (a domain name). */
export function isValidHandle(handle: string): boolean {
  return handle.length <= 253 && HANDLE_RE.test(handle);
}
