/**
 * Verifiable Credential Data Model 2.0 shapes and structural validation.
 *
 * Plain-data helpers: assemble an unsigned credential, validate the required VCDM
 * 2.0 members before signing or after verifying, and evaluate the validity
 * window. No Web Crypto, no runtime — the proof lives in {@link ./data-integrity}.
 *
 * @see https://www.w3.org/TR/vc-data-model-2.0/
 */

import type { JcsValue } from "./jcs";
import type { JsonObject } from "./data-integrity";

/** The base VCDM 2.0 context, which MUST be the first `@context` entry. */
export const VC_CONTEXT_V2 = "https://www.w3.org/ns/credentials/v2";

/** The base credential type every verifiable credential carries. */
export const VERIFIABLE_CREDENTIAL_TYPE = "VerifiableCredential";

/** An issuer reference: a URL string or an object with an `id`. */
export type Issuer = string | (JsonObject & { id: string });

/** A credential prior to having a proof attached. */
export interface UnsignedCredential extends JsonObject {
  "@context": JcsValue;
  type: JcsValue;
  issuer: Issuer;
  credentialSubject: JcsValue;
}

/** Inputs to {@link buildCredential}. */
export interface BuildCredentialOptions {
  /** Extra credential types beyond `VerifiableCredential`. */
  readonly type?: string | readonly string[];
  /** Extra `@context` entries beyond the base VCDM 2.0 context. */
  readonly context?: string | readonly string[];
  /** The credential id (a URL), if any. */
  readonly id?: string;
  readonly issuer: Issuer;
  readonly credentialSubject: JcsValue;
  /** `validFrom` (XSD dateTime). Defaults to now when omitted. */
  readonly validFrom?: Date | string;
  /** `validUntil` (XSD dateTime). */
  readonly validUntil?: Date | string;
  /** A `credentialStatus` entry (e.g. a Bitstring Status List reference). */
  readonly credentialStatus?: JsonObject | readonly JsonObject[];
}

function toXsdDateTime(value: Date | string): string {
  if (typeof value === "string") return value;
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dedupePrepend(
  base: string,
  extra: string | readonly string[] | undefined,
): string[] {
  const out = [base];
  if (extra === undefined) return out;
  const list = typeof extra === "string" ? [extra] : extra;
  for (const item of list) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Assemble an unsigned VCDM 2.0 credential, guaranteeing the base context comes
 * first and the base `VerifiableCredential` type is present. The result is ready
 * for {@link ./data-integrity.addProof}.
 */
export function buildCredential(
  options: BuildCredentialOptions,
): UnsignedCredential {
  const credential: UnsignedCredential = {
    "@context": dedupePrepend(VC_CONTEXT_V2, options.context),
    type: dedupePrepend(VERIFIABLE_CREDENTIAL_TYPE, options.type),
    issuer: options.issuer,
    credentialSubject: options.credentialSubject,
  };
  if (options.id !== undefined) credential.id = options.id;
  credential.validFrom = toXsdDateTime(options.validFrom ?? new Date());
  if (options.validUntil !== undefined) {
    credential.validUntil = toXsdDateTime(options.validUntil);
  }
  if (options.credentialStatus !== undefined) {
    credential.credentialStatus = Array.isArray(options.credentialStatus)
      ? [...options.credentialStatus]
      : (options.credentialStatus as JsonObject);
  }
  return credential;
}

function hasType(type: JcsValue | undefined, expected: string): boolean {
  if (type === expected) return true;
  return Array.isArray(type) && type.includes(expected);
}

function firstContext(context: JcsValue | undefined): JcsValue | undefined {
  if (Array.isArray(context)) return context[0];
  return context;
}

/**
 * Validate the structural VCDM 2.0 requirements of a credential, returning a
 * list of problems (empty when valid). Checks the base context ordering, the
 * `VerifiableCredential` type, and the presence/typing of `issuer` and
 * `credentialSubject`. Does not check the proof — that is
 * {@link ./data-integrity.verifyProof}.
 */
export function validateCredential(credential: JsonObject): string[] {
  const errors: string[] = [];

  if (firstContext(credential["@context"]) !== VC_CONTEXT_V2) {
    errors.push(`@context must begin with "${VC_CONTEXT_V2}"`);
  }
  if (!hasType(credential.type, VERIFIABLE_CREDENTIAL_TYPE)) {
    errors.push(`type must include "${VERIFIABLE_CREDENTIAL_TYPE}"`);
  }

  const issuer = credential.issuer;
  const issuerOk =
    typeof issuer === "string"
      ? issuer.length > 0
      : issuer !== null &&
        typeof issuer === "object" &&
        !Array.isArray(issuer) &&
        typeof (issuer as JsonObject).id === "string";
  if (!issuerOk) {
    errors.push("issuer must be a URL string or an object with a string id");
  }

  const subject = credential.credentialSubject;
  const subjectOk =
    subject !== null &&
    subject !== undefined &&
    typeof subject === "object" &&
    (!Array.isArray(subject) || subject.length > 0);
  if (!subjectOk) {
    errors.push("credentialSubject must be an object or a non-empty array");
  }

  if (credential.id !== undefined && typeof credential.id !== "string") {
    errors.push("id, when present, must be a string");
  }

  return errors;
}

/** The issuer id of a credential, whether `issuer` is a string or an object. */
export function issuerId(credential: JsonObject): string | undefined {
  const issuer = credential.issuer;
  if (typeof issuer === "string") return issuer;
  if (issuer !== null && typeof issuer === "object" && !Array.isArray(issuer)) {
    const id = (issuer as JsonObject).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Evaluate a credential's validity window against `now` (epoch ms). Returns a
 * reason when the credential is not yet valid or has expired, else `null`.
 */
export function checkValidityPeriod(
  credential: JsonObject,
  now: number = Date.now(),
): "not_yet_valid" | "expired" | null {
  const validFrom = credential.validFrom;
  if (typeof validFrom === "string") {
    const from = Date.parse(validFrom);
    if (!Number.isNaN(from) && now < from) return "not_yet_valid";
  }
  const validUntil = credential.validUntil;
  if (typeof validUntil === "string") {
    const until = Date.parse(validUntil);
    if (!Number.isNaN(until) && now > until) return "expired";
  }
  return null;
}
