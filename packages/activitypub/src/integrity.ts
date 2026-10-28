/**
 * FEP-8b32 Object Integrity Proofs for this actor's outbound activities.
 *
 * When the deployment configures an Ed25519 `integrityKey`, the actor document
 * publishes its public half as a FEP-521a `assertionMethod` `Multikey`, and
 * every activity this actor authors is delivered with a top-level
 * `DataIntegrityProof` (`eddsa-jcs-2022`), so a recipient can authenticate it
 * independently of the HTTP signature — e.g. after it has been forwarded.
 * Activities authored by anyone else (inbox forwarding, relayed objects) are
 * never signed: a proof asserts authorship.
 *
 * The proof pipeline itself (JCS canonicalization, hashing, Ed25519 signing,
 * Multikey encoding) is `@dwk/vc/data-integrity`'s, not reimplemented here.
 *
 * @see https://codeberg.org/fediverse/fep/src/branch/main/fep/8b32/fep-8b32.md
 * @see https://codeberg.org/fediverse/fep/src/branch/main/fep/521a/fep-521a.md
 */

import {
  addProof,
  encodeEd25519Multikey,
  importSigner,
  type JsonObject,
  type Signer,
} from "@dwk/vc/data-integrity";

import { AS2_NS, DATA_INTEGRITY_CONTEXT, type JsonValue } from "./as2.js";

/** The verification-method id an actor's integrity proofs name. */
export function integrityKeyId(actorId: string): string {
  return `${actorId}#ed25519-key`;
}

/** Decode unpadded base64url (a JWK member) to bytes. */
export function base64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Byte length of a base64url JWK member, or -1 when absent or malformed. */
function decodedLength(value: unknown): number {
  if (typeof value !== "string") return -1;
  try {
    return base64urlToBytes(value).length;
  } catch {
    return -1;
  }
}

/**
 * Validate a configured integrity key: an Ed25519 private JWK (`kty: "OKP"`,
 * `crv: "Ed25519"`, a 32-byte `x`, and a 32-byte `d`). Throws a descriptive
 * error otherwise, so a misconfigured key fails loudly at startup. Whether `d`
 * matches `x` is only knowable by importing the key, which is async; the DO
 * handles a key that still fails to import by delivering without a proof.
 */
export function assertIntegrityKey(jwk: JsonWebKey): void {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error(
      '@dwk/activitypub: `integrityKey` must be an Ed25519 JWK (kty "OKP", crv "Ed25519")',
    );
  }
  if (typeof jwk.d !== "string" || jwk.d === "") {
    throw new Error(
      "@dwk/activitypub: `integrityKey` must be a private JWK (missing `d`)",
    );
  }
  if (decodedLength(jwk.x) !== 32) {
    throw new Error(
      "@dwk/activitypub: `integrityKey.x` must be a 32-byte base64url Ed25519 public key",
    );
  }
  if (decodedLength(jwk.d) !== 32) {
    throw new Error(
      "@dwk/activitypub: `integrityKey.d` must be a 32-byte base64url Ed25519 seed",
    );
  }
}

/**
 * The FEP-521a `assertionMethod` entry publishing `jwk`'s public half as a
 * `Multikey` controlled by `actorId`.
 */
export function buildAssertionMethod(
  actorId: string,
  jwk: JsonWebKey,
): Record<string, JsonValue> {
  return {
    id: integrityKeyId(actorId),
    type: "Multikey",
    controller: actorId,
    publicKeyMultibase: encodeEd25519Multikey(base64urlToBytes(jwk.x!)),
  };
}

/** An imported integrity key, ready to sign this actor's activities. */
export interface IntegritySigner {
  readonly actorId: string;
  readonly verificationMethod: string;
  readonly signer: Signer;
}

/** Import `jwk` as `actorId`'s integrity signer. */
export async function importIntegritySigner(
  actorId: string,
  jwk: JsonWebKey,
): Promise<IntegritySigner> {
  return {
    actorId,
    verificationMethod: integrityKeyId(actorId),
    signer: await importSigner(jwk),
  };
}

/** The IRI of an activity's `actor`, whether a string or an `{ id }` object. */
function actorOf(activity: Record<string, unknown>): string | undefined {
  const actor = activity.actor;
  if (typeof actor === "string") return actor;
  if (actor !== null && typeof actor === "object" && !Array.isArray(actor)) {
    const id = (actor as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * Add a FEP-8b32 integrity proof to `activityJson` if, and only if, it is
 * authored by the signer's actor and does not already carry a proof. Anything
 * else — another actor's activity being forwarded, an already-proofed one, an
 * activity with a fragment `id` (FEP-8b32: such objects SHOULD NOT carry
 * proofs), or unparseable JSON — is returned unchanged.
 *
 * `@context` gains the Data Integrity context (it defines the `proof` term);
 * the proof copies the resulting `@context`, as the cryptosuite requires.
 */
export async function signOwnActivity(
  activityJson: string,
  integrity: IntegritySigner,
  now: () => number = () => Date.now(),
): Promise<string> {
  let activity: unknown;
  try {
    activity = JSON.parse(activityJson);
  } catch {
    return activityJson;
  }
  if (
    activity === null ||
    typeof activity !== "object" ||
    Array.isArray(activity)
  ) {
    return activityJson;
  }
  const doc = activity as Record<string, unknown>;
  if (
    actorOf(doc) !== integrity.actorId ||
    doc.proof !== undefined ||
    (typeof doc.id === "string" && doc.id.includes("#"))
  ) {
    return activityJson;
  }
  const context = doc["@context"];
  const contexts: unknown[] =
    context === undefined
      ? [AS2_NS]
      : Array.isArray(context)
        ? [...context]
        : [context];
  if (!contexts.includes(DATA_INTEGRITY_CONTEXT)) {
    contexts.push(DATA_INTEGRITY_CONTEXT);
  }
  const secured = await addProof(
    { ...doc, "@context": contexts } as JsonObject,
    integrity.signer,
    {
      verificationMethod: integrity.verificationMethod,
      created: new Date(now()),
    },
  );
  return JSON.stringify(secured);
}
