/**
 * Scoped **app passwords** — the WebDAV auth bridge (spec §1).
 *
 * Every OS WebDAV client speaks Basic/Digest only; none can present a DPoP-bound
 * token or run an IndieAuth / Solid-OIDC flow. This module mints and verifies a
 * single, deliberate, scoped exception to the repo's "DPoP everywhere" rule:
 *
 * - A long (256-bit) random secret bound to `(WebID, label, scope, expiry)`,
 *   presented as the password half of HTTP **Basic** over HTTPS.
 * - The username is an opaque, **colon-free** credential id (never the raw
 *   WebID — Basic splits on the first colon, which a `https://…` WebID would
 *   break). The WebID is bound server-side, not carried on the wire.
 * - Stored **only as a salted PBKDF2-HMAC-SHA-256 hash** (WebCrypto; Argon2 is
 *   unavailable in workerd). The plaintext is returned once at mint time and
 *   never persisted. Digest is therefore not offered — it needs a reversible
 *   secret at rest.
 * - Verification is **constant-time**. Throttling and at-rest storage are the
 *   caller's concern (the per-pod DO).
 *
 * Pure (WebCrypto only), so it unit-tests without a Workers runtime.
 */

/** Upper bound on what a credential may do; intersected with WAC at request time. */
export interface AppPasswordScope {
  /** Access modes the credential may exercise (a ceiling, never a grant). */
  readonly modes: readonly ("read" | "write")[];
  /** Optional path prefix the credential is confined to. */
  readonly pathPrefix?: string;
}

/** The persisted shape of an app password — hash only, never the plaintext. */
export interface AppPasswordRecord {
  /** Opaque, colon-free credential id; also the Basic username. */
  readonly credentialId: string;
  /** The WebID this credential authenticates as. */
  readonly webid: string;
  /** Human-facing label, e.g. "MacBook Finder". */
  readonly label: string;
  readonly scope: AppPasswordScope;
  readonly saltHex: string;
  readonly hashHex: string;
  readonly iterations: number;
  readonly createdAt: number;
  /** Epoch ms after which the credential is invalid, or `null` for no expiry. */
  readonly expiresAt: number | null;
}

/** The result of minting — the record to store plus the once-shown plaintext. */
export interface MintedAppPassword {
  readonly record: AppPasswordRecord;
  /** The Basic username to give the user (equal to `record.credentialId`). */
  readonly username: string;
  /** The Basic password to show the user **once**; never persisted. */
  readonly secret: string;
}

/** Parameters for {@link mintAppPassword}. */
export interface MintAppPasswordParams {
  readonly webid: string;
  readonly label: string;
  readonly scope: AppPasswordScope;
  /** PBKDF2 iterations; defaults to {@link DEFAULT_PBKDF2_ITERATIONS}. */
  readonly iterations?: number;
  /** Epoch ms expiry, or `null` for none. */
  readonly expiresAt?: number | null;
  /** Clock injection for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Deployment-wide pepper (`WEBDAV_PEPPER`), mixed into the hash when set. */
  readonly pepper?: string;
}

/**
 * workerd's `crypto.subtle.deriveBits` hard-rejects PBKDF2 iteration counts
 * above this (`NotSupportedError`), regardless of what OWASP or a deployer's
 * config asks for.
 */
export const PBKDF2_ITERATION_CEILING = 100_000;

/**
 * PBKDF2-HMAC-SHA-256 iteration count. OWASP's 2023 guidance recommends
 * 600,000, but that exceeds {@link PBKDF2_ITERATION_CEILING}, so this is
 * capped there instead — still within OWASP's longstanding prior-generation
 * minimum.
 */
export const DEFAULT_PBKDF2_ITERATIONS = PBKDF2_ITERATION_CEILING;

const HASH_BYTES = 32;
const SALT_BYTES = 16;
const SECRET_BYTES = 32; // 256-bit, comfortably ≥ the 128-bit spec floor
const CREDENTIAL_ID_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a colon-free credential id usable as a Basic username. */
export function generateCredentialId(): string {
  return `wdav-${randomBase64Url(CREDENTIAL_ID_BYTES)}`;
}

/** Mint a fresh ≥128-bit app-password secret (URL-safe, colon-free). */
export function generateSecret(): string {
  return randomBase64Url(SECRET_BYTES);
}

/**
 * Prepend the deployment-wide pepper (`WEBDAV_PEPPER`), when configured, to
 * the per-credential secret before hashing. Unlike the per-record `salt`
 * (stored alongside the hash, so it adds nothing against a stolen database),
 * the pepper never leaves Worker secret storage — an attacker who exfiltrates
 * the DO SQLite table alone still cannot brute-force credentials offline
 * without it. Not retroactive: changing (or newly setting/unsetting)
 * `WEBDAV_PEPPER` changes the hash input for every future `verify`, so
 * credentials minted under a different pepper value stop verifying — the
 * same operational tradeoff as rotating any other KDF parameter.
 */
function pepperedSecret(secret: string, pepper?: string): string {
  return pepper ? `${pepper}:${secret}` : secret;
}

async function deriveHash(
  secret: string,
  salt: Uint8Array,
  iterations: number,
  pepper?: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepperedSecret(secret, pepper)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Constant-time comparison of two equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Mint an app password: generate the secret + credential id, derive the salted
 * hash, and return the record to persist alongside the once-shown plaintext.
 */
export async function mintAppPassword(
  params: MintAppPasswordParams,
): Promise<MintedAppPassword> {
  const iterations = params.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (iterations > PBKDF2_ITERATION_CEILING) {
    // Fail loudly (spec/composition-contract.md) instead of letting a
    // deployer-configured value above the ceiling surface as an opaque
    // WebCrypto NotSupportedError deep inside deriveBits.
    throw new Error(
      `mintAppPassword: iterations (${iterations}) exceeds workerd's PBKDF2 ` +
        `ceiling of ${PBKDF2_ITERATION_CEILING}; crypto.subtle.deriveBits ` +
        `would throw NotSupportedError`,
    );
  }
  const now = params.now ?? Date.now;
  const credentialId = generateCredentialId();
  const secret = generateSecret();
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await deriveHash(secret, salt, iterations, params.pepper);
  const record: AppPasswordRecord = {
    credentialId,
    webid: params.webid,
    label: params.label,
    scope: params.scope,
    saltHex: toHex(salt),
    hashHex: toHex(hash),
    iterations,
    createdAt: now(),
    expiresAt: params.expiresAt ?? null,
  };
  return { record, username: credentialId, secret };
}

/**
 * Verify a presented secret against a stored record in constant time, honouring
 * expiry. Returns `false` (never throws) on any mismatch or expiry.
 */
export async function verifyAppPassword(
  secret: string,
  record: AppPasswordRecord,
  now: () => number = Date.now,
  pepper?: string,
): Promise<boolean> {
  if (record.expiresAt !== null && now() >= record.expiresAt) return false;
  const expected = fromHex(record.hashHex);
  const actual = await deriveHash(
    secret,
    fromHex(record.saltHex),
    record.iterations,
    pepper,
  );
  return timingSafeEqual(actual, expected);
}

/** A decoded HTTP Basic credential, split on the **first** colon (RFC 7617). */
export interface BasicCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * Decode an `Authorization: Basic …` header. Returns `null` when the scheme is
 * not Basic, the base64 is invalid, or there is no colon separator.
 */
export function parseBasicAuthorization(
  header: string | null | undefined,
): BasicCredential | null {
  if (!header) return null;
  const match = /^basic\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  let decoded: string;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    decoded = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}

/** Whether a request URL is HTTPS — Basic credentials are refused otherwise. */
export function isHttpsRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
