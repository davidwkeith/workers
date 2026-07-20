/**
 * The RFC 9421 wire profile: the `Signature-Input` / `Signature`
 * structured-field pair, the signature base of §2.5, and the `@signature-params`
 * line.
 */

import {
  deriveAlgFromKey,
  isSupportedAlgorithm,
  signBytes,
  validateKey,
  verifyBytes,
} from "./algorithms.js";
import { bytesToBase64, utf8 } from "./base64.js";
import { deriveComponentValue, derivationContext } from "./components.js";
import {
  parseSignatureHeader,
  parseSignatureInput,
  serializeString,
  type SfBareItem,
} from "./sf.js";
import type {
  HttpMessage,
  SignatureAlgorithm,
  SignatureFailureReason,
  VerifyResult,
} from "./types.js";

/** Resolved signing inputs for the RFC 9421 profile. */
export interface Rfc9421SignParams {
  key: CryptoKey;
  keyId: string;
  alg: SignatureAlgorithm;
  components: string[];
  created: number;
  expires?: number;
  nonce?: string;
  tag?: string;
  label: string;
}

/** Build the `@signature-params` value (inner list plus its parameters). */
function signatureParamsValue(params: Rfc9421SignParams): string {
  const items = params.components.map(serializeString).join(" ");
  let out = `(${items});created=${params.created}`;
  if (params.expires !== undefined) out += `;expires=${params.expires}`;
  out += `;keyid=${serializeString(params.keyId)}`;
  out += `;alg=${serializeString(params.alg)}`;
  if (params.nonce !== undefined)
    out += `;nonce=${serializeString(params.nonce)}`;
  if (params.tag !== undefined) out += `;tag=${serializeString(params.tag)}`;
  return out;
}

/** Build the signature base over `lines` and the `@signature-params` value. */
function signatureBase(lines: string[], sigParams: string): string {
  return [...lines, `"@signature-params": ${sigParams}`].join("\n");
}

/**
 * Sign `message` under the RFC 9421 profile. Returns the `Signature-Input` and
 * `Signature` headers to merge into the request. Throws if a covered component
 * is absent from the message or the URL cannot be parsed — both signer bugs.
 */
export async function signRfc9421(
  message: HttpMessage,
  params: Rfc9421SignParams,
): Promise<Record<string, string>> {
  const ctx = derivationContext(message);
  if (ctx === null)
    throw new Error("http-signatures: message.url is not a valid URL");
  const sigParams = signatureParamsValue(params);
  const lines: string[] = [];
  // RFC 9421 §2: each component identifier MUST occur only once in the covered
  // component list. A repeated identifier is a signer bug — reject it loudly.
  const seen = new Set<string>();
  for (const name of params.components) {
    const id = name.toLowerCase();
    if (seen.has(id)) {
      throw new Error(
        `http-signatures: duplicate covered component "${name}" (RFC 9421 §2)`,
      );
    }
    seen.add(id);
    const value = deriveComponentValue(ctx, name);
    if (value === null) {
      throw new Error(
        `http-signatures: covered component "${name}" is missing from the message`,
      );
    }
    lines.push(`${serializeString(name)}: ${value}`);
  }
  const signature = await signBytes(
    params.key,
    params.alg,
    utf8(signatureBase(lines, sigParams)),
  );
  return {
    "Signature-Input": `${params.label}=${sigParams}`,
    Signature: `${params.label}=:${bytesToBase64(new Uint8Array(signature))}:`,
  };
}

/** Resolves a public key (and optionally the algorithm it dictates) for verification. */
export type KeyResolver = (params: {
  keyId: string | null;
  alg: SignatureAlgorithm | null;
}) => Promise<CryptoKey | null> | (CryptoKey | null);

/** Parameters for verifying an RFC 9421 signature. */
export interface Rfc9421VerifyParams {
  resolveKey: KeyResolver;
  /** Which labelled signature to verify; required when the message carries more than one. */
  label?: string;
  /** Component identifiers that MUST be covered (e.g. `@method`, `date`). */
  requiredComponents?: string[];
  /** Require a `created` parameter to be present. */
  requireCreated?: boolean;
  /** Current time, epoch seconds. Defaults to `Date.now()`. */
  now?: number;
  /** Allowed clock skew, in seconds, for `created`/`expires`. Defaults to 300. */
  toleranceSeconds?: number;
  /**
   * Maximum age of a `created` timestamp, in seconds. A signature whose
   * `created` is older than `now - maxAgeSeconds` (allowing `toleranceSeconds`
   * of skew) is rejected as `created_stale`, so a captured proof cannot be
   * replayed indefinitely when it carries no `expires`. Defaults to 3600 (1
   * hour); pass `Infinity` to disable. Only applies when `created` is present.
   */
  maxAgeSeconds?: number;
}

function paramMap(
  params: Array<[string, SfBareItem]>,
): Map<string, SfBareItem> {
  const map = new Map<string, SfBareItem>();
  for (const [k, v] of params) map.set(k, v);
  return map;
}

function getHeader(message: HttpMessage, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(message.headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(", ") : v;
  }
  return null;
}

function fail(reason: SignatureFailureReason): VerifyResult {
  return { valid: false, profile: "rfc9421", reason };
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_AGE_SECONDS = 3600;

/**
 * Verify an RFC 9421 signature on `message`. Never throws — every failure is a
 * `{ valid: false, reason }` with a stable {@link SignatureFailureReason}.
 */
export async function verifyRfc9421(
  message: HttpMessage,
  params: Rfc9421VerifyParams,
): Promise<VerifyResult> {
  const inputHeader = getHeader(message, "signature-input");
  const sigHeader = getHeader(message, "signature");
  if (inputHeader === null || sigHeader === null)
    return fail("signature_missing");

  let inputs: ReturnType<typeof parseSignatureInput>;
  let signatures: ReturnType<typeof parseSignatureHeader>;
  try {
    inputs = parseSignatureInput(inputHeader);
  } catch {
    return fail("signature_input_malformed");
  }
  try {
    signatures = parseSignatureHeader(sigHeader);
  } catch {
    return fail("signature_malformed");
  }

  // Choose the label to verify.
  let label = params.label;
  if (label === undefined) {
    if (inputs.size === 0) return fail("label_missing");
    if (inputs.size > 1) return fail("label_ambiguous");
    label = [...inputs.keys()][0]!;
  }
  const input = inputs.get(label);
  if (input === undefined) return fail("label_missing");
  const signature = signatures.get(label);
  if (signature === undefined) return fail("signature_missing");

  const sigParams = paramMap(input.params);
  // RFC 9421 §2.3: `alg` is OPTIONAL. When present it must be allow-listed;
  // when absent the algorithm is derived from the resolved key below.
  const algRaw = sigParams.get("alg");
  let alg: SignatureAlgorithm | null = null;
  if (algRaw !== undefined) {
    if (typeof algRaw !== "string" || !isSupportedAlgorithm(algRaw)) {
      return fail("alg_unsupported");
    }
    alg = algRaw;
  }
  const keyIdRaw = sigParams.get("keyid");
  const keyId = typeof keyIdRaw === "string" ? keyIdRaw : null;
  if (keyId === null) return fail("keyid_missing");

  // created / expires window.
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  let created: number | undefined;
  if (sigParams.has("created")) {
    const c = sigParams.get("created");
    if (typeof c !== "number" || !Number.isInteger(c))
      return fail("created_invalid");
    created = c;
    if (c > now + tolerance) return fail("signature_future");
    // Lower-bound the age so a signature without `expires` cannot be replayed
    // indefinitely. `Infinity` disables the bound.
    const maxAge = params.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (c < now - tolerance - maxAge) return fail("created_stale");
  } else if (params.requireCreated) {
    return fail("created_required");
  }
  let expires: number | undefined;
  if (sigParams.has("expires")) {
    const e = sigParams.get("expires");
    if (typeof e !== "number" || !Number.isInteger(e))
      return fail("expires_invalid");
    expires = e;
    if (now > e + tolerance) return fail("signature_expired");
  }
  // RFC 9421 §2.3: `expires` MUST NOT precede `created`.
  if (created !== undefined && expires !== undefined && expires < created) {
    return fail("expires_invalid");
  }

  const coveredComponents = input.items.map((item) => String(item.value));

  // Required-component policy.
  if (params.requiredComponents) {
    const covered = new Set(coveredComponents.map((c) => c.toLowerCase()));
    for (const required of params.requiredComponents) {
      if (!covered.has(required.toLowerCase()))
        return fail("required_component_missing");
    }
  }

  // Rebuild the signature base from the named components.
  const ctx = derivationContext(message);
  if (ctx === null) return fail("covered_component_missing");
  const lines: string[] = [];
  // RFC 9421 §2 / §2.5: each component identifier (name plus its serialized
  // parameters) MUST occur only once; a repeated identifier is malformed.
  const seen = new Set<string>();
  for (const item of input.items) {
    if (item.params.length > 0 || typeof item.value !== "string") {
      return fail("components_malformed");
    }
    const id = item.value.toLowerCase();
    if (seen.has(id)) return fail("components_malformed");
    seen.add(id);
    const value = deriveComponentValue(ctx, item.value);
    if (value === null) return fail("covered_component_missing");
    lines.push(`${item.raw}: ${value}`);
  }
  const base = [...lines, `"@signature-params": ${input.raw}`].join("\n");

  // Resolve and validate the key, then verify. When `alg` was omitted, derive
  // it from the resolved key's type (RFC 9421 §2.3).
  const key = await params.resolveKey({ keyId, alg });
  if (key === null) return fail("key_unresolved");
  if (alg === null) {
    alg = deriveAlgFromKey(key);
    if (alg === null) return fail("alg_unsupported");
  }
  const rejection = validateKey(key, alg);
  if (rejection !== null) return fail(rejection);

  const ok = await verifyBytes(key, alg, signature, utf8(base));
  if (!ok) return fail("signature_invalid");

  return {
    valid: true,
    profile: "rfc9421",
    label,
    keyId,
    coveredComponents,
    created,
    expires,
  };
}
