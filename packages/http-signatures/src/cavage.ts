/**
 * The legacy `draft-cavage-http-signatures` "Signature" profile that much of
 * the fediverse still emits. A single `Signature` header carries the `keyId`,
 * `algorithm`, the space-separated `headers` list, and the base64 `signature`;
 * the signing string is the `headers` components joined by newlines, where
 * `(request-target)`, `(created)`, and `(expires)` are pseudo-headers.
 */

import {
  deriveAlgFromKey,
  isSupportedAlgorithm,
  signBytes,
  validateKey,
  verifyBytes,
} from "./algorithms";
import { base64ToBytes, bytesToBase64, utf8 } from "./base64";
import { derivationContext, type DerivationContext } from "./components";
import type { KeyResolver } from "./rfc9421";
import type {
  HttpMessage,
  SignatureAlgorithm,
  SignatureFailureReason,
  VerifyResult,
} from "./types";

/** Map our algorithm identifiers to a `draft-cavage` `algorithm` token. */
const CAVAGE_TOKEN: Record<SignatureAlgorithm, string> = {
  "rsa-v1_5-sha256": "rsa-sha256",
  "rsa-pss-sha512": "hs2019",
  "ecdsa-p256-sha256": "ecdsa-sha256",
  "ecdsa-p384-sha384": "ecdsa-sha384",
  ed25519: "ed25519",
};

/** Map a `draft-cavage` `algorithm` token to our identifier, or `null` for `hs2019`. */
function tokenToAlg(token: string): SignatureAlgorithm | "derive" | null {
  switch (token.toLowerCase()) {
    case "rsa-sha256":
      return "rsa-v1_5-sha256";
    case "ecdsa-sha256":
      return "ecdsa-p256-sha256";
    case "ecdsa-sha384":
      return "ecdsa-p384-sha384";
    case "ed25519":
      return "ed25519";
    case "hs2019":
      return "derive";
    default:
      return null;
  }
}

/** Build the `draft-cavage` signing string, or report the first missing component. */
function buildSigningString(
  ctx: DerivationContext,
  components: string[],
  times: { created?: number; expires?: number },
): { string: string } | { missing: string } {
  const lines: string[] = [];
  for (const raw of components) {
    const name = raw.toLowerCase();
    let value: string | null;
    if (name === "(request-target)") {
      value = `${ctx.message.method.toLowerCase()} ${ctx.url.pathname}${ctx.url.search}`;
    } else if (name === "(created)") {
      value = times.created === undefined ? null : String(times.created);
    } else if (name === "(expires)") {
      value = times.expires === undefined ? null : String(times.expires);
    } else {
      value = ctx.headers.get(name) ?? null;
    }
    if (value === null) return { missing: name };
    lines.push(`${name}: ${value}`);
  }
  return { string: lines.join("\n") };
}

/** Resolved signing inputs for the `draft-cavage` profile. */
export interface CavageSignParams {
  key: CryptoKey;
  keyId: string;
  alg: SignatureAlgorithm;
  /** Cavage-style component names, e.g. `["(request-target)", "host", "date", "digest"]`. */
  components: string[];
  created?: number;
  expires?: number;
}

/**
 * Sign `message` under the `draft-cavage` profile. Returns the single
 * `Signature` header to merge into the request. Throws if a covered component
 * is absent — a signer bug.
 */
export async function signCavage(
  message: HttpMessage,
  params: CavageSignParams,
): Promise<Record<string, string>> {
  const ctx = derivationContext(message);
  if (ctx === null)
    throw new Error("http-signatures: message.url is not a valid URL");
  const built = buildSigningString(ctx, params.components, {
    created: params.created,
    expires: params.expires,
  });
  if ("missing" in built) {
    throw new Error(
      `http-signatures: covered component "${built.missing}" is missing from the message`,
    );
  }
  const signature = await signBytes(params.key, params.alg, utf8(built.string));
  const parts = [
    `keyId="${params.keyId}"`,
    `algorithm="${CAVAGE_TOKEN[params.alg]}"`,
    `headers="${params.components.map((c) => c.toLowerCase()).join(" ")}"`,
    `signature="${bytesToBase64(new Uint8Array(signature))}"`,
  ];
  if (params.created !== undefined) parts.push(`created=${params.created}`);
  if (params.expires !== undefined) parts.push(`expires=${params.expires}`);
  return { Signature: parts.join(",") };
}

/** Parse a `draft-cavage` `Signature` header into its named members. */
function parseCavageHeader(value: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < value.length) {
    while (
      i < value.length &&
      (value[i] === " " || value[i] === "," || value[i] === "\t")
    )
      i++;
    const eq = value.indexOf("=", i);
    if (eq < 0) break;
    const key = value.slice(i, eq).trim();
    i = eq + 1;
    let raw: string;
    if (value[i] === '"') {
      i++;
      let s = "";
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) i++;
        s += value[i];
        i++;
      }
      i++; // closing quote
      raw = s;
    } else {
      let j = i;
      while (j < value.length && value[j] !== ",") j++;
      raw = value.slice(i, j).trim();
      i = j;
    }
    if (key) out.set(key.toLowerCase(), raw);
  }
  return out;
}

/** Parameters for verifying a `draft-cavage` signature. */
export interface CavageVerifyParams {
  resolveKey: KeyResolver;
  requiredComponents?: string[];
  now?: number;
  toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function getHeader(message: HttpMessage, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(message.headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(", ") : v;
  }
  return null;
}

function fail(reason: SignatureFailureReason): VerifyResult {
  return { valid: false, profile: "cavage", reason };
}

function parseIntegerParam(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * Verify a `draft-cavage` signature on `message`. Never throws — failures are
 * returned as `{ valid: false, reason }`.
 */
export async function verifyCavage(
  message: HttpMessage,
  params: CavageVerifyParams,
): Promise<VerifyResult> {
  const header = getHeader(message, "signature");
  if (header === null) return fail("signature_missing");

  const fields = parseCavageHeader(header);
  const sigB64 = fields.get("signature");
  if (sigB64 === undefined) return fail("signature_malformed");
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(sigB64);
  } catch {
    return fail("signature_malformed");
  }

  const keyId = fields.get("keyid") ?? null;
  if (keyId === null) return fail("keyid_missing");

  const token = fields.get("algorithm");
  const createdRaw = parseIntegerParam(fields.get("created"));
  if (createdRaw === null) return fail("created_invalid");
  const expiresRaw = parseIntegerParam(fields.get("expires"));
  if (expiresRaw === null) return fail("expires_invalid");

  // Default covered-component list when no explicit `headers` is sent.
  // draft-cavage-12 §2.1.6 specifies the default is `(created)` unconditionally.
  // We deliberately diverge: when `created` is absent we fall back to `date`,
  // matching the older "Signing HTTP Messages" rule that essentially every
  // fediverse peer implements. In practice senders always send an explicit
  // `headers`, so this branch is rarely reached; the divergence only affects
  // the (non-conforming) case of a signature with neither `headers` nor
  // `created`, where interop with real-world peers beats spec-literalism.
  const headersList = fields.get("headers");
  const components = headersList
    ? headersList.split(/\s+/).filter(Boolean)
    : createdRaw !== undefined
      ? ["(created)"]
      : ["date"];

  // Resolve the algorithm. `hs2019` (and a missing token) defer to the key type.
  let alg: SignatureAlgorithm | null = null;
  if (token !== undefined) {
    const mapped = tokenToAlg(token);
    if (mapped === null) return fail("alg_unsupported");
    if (mapped !== "derive") alg = mapped;
  }

  const key = await params.resolveKey({ keyId, alg });
  if (key === null) return fail("key_unresolved");
  if (alg === null) {
    alg = deriveAlgFromKey(key);
    if (alg === null || !isSupportedAlgorithm(alg))
      return fail("alg_unsupported");
  }
  const rejection = validateKey(key, alg);
  if (rejection !== null) return fail(rejection);

  // created / expires window.
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (createdRaw !== undefined && createdRaw > now + tolerance)
    return fail("signature_future");
  if (expiresRaw !== undefined && now > expiresRaw + tolerance)
    return fail("signature_expired");
  // RFC 9421 §2.3 / draft-cavage: `expires` MUST NOT precede `created`.
  if (
    createdRaw !== undefined &&
    expiresRaw !== undefined &&
    expiresRaw < createdRaw
  )
    return fail("expires_invalid");

  // Required-component policy.
  if (params.requiredComponents) {
    const covered = new Set(components.map((c) => c.toLowerCase()));
    for (const required of params.requiredComponents) {
      if (!covered.has(required.toLowerCase()))
        return fail("required_component_missing");
    }
  }

  const ctx = derivationContext(message);
  if (ctx === null) return fail("covered_component_missing");
  const built = buildSigningString(ctx, components, {
    created: createdRaw,
    expires: expiresRaw,
  });
  if ("missing" in built) return fail("covered_component_missing");

  const ok = await verifyBytes(key, alg, signature, utf8(built.string));
  if (!ok) return fail("signature_invalid");

  return {
    valid: true,
    profile: "cavage",
    keyId,
    coveredComponents: components,
    created: createdRaw,
    expires: expiresRaw,
  };
}
