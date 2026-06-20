/**
 * Session authentication for the XRPC surface. `com.atproto.server.createSession`
 * exchanges an account password for short-lived access / refresh JWTs; protected
 * `com.atproto.repo.*` writes require a valid access JWT.
 *
 * The JWTs are HS256, signed with a configured secret using WebCrypto HMAC — no
 * `node:crypto`, no JWT library. This is deliberately the simplest correct
 * scheme: a self-hosted single-account PDS authenticates its one owner, so the
 * elaborate multi-tenant token machinery of a hosted PDS is unnecessary.
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "===".slice((padded.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Claims carried by an access / refresh token. */
export interface SessionClaims {
  /** Subject — the account DID. */
  readonly sub: string;
  /** Token scope (`com.atproto.access` or `com.atproto.refresh`). */
  readonly scope: string;
  /** Expiry, epoch seconds. */
  readonly exp: number;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
}

/** Mint a signed HS256 JWT for the given claims. */
export async function signJwt(
  secret: string,
  claims: SessionClaims,
): Promise<string> {
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      encoder.encode(signingInput) as BufferSource,
    ),
  );
  return `${signingInput}.${base64url(sig)}`;
}

/** Verify a JWT and return its claims, or `null` if invalid/expired. */
export async function verifyJwt(
  secret: string,
  token: string,
  now: () => number = () => Date.now(),
): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    base64urlDecode(sig) as BufferSource,
    encoder.encode(`${header}.${payload}`) as BufferSource,
  );
  if (!valid) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now()) return null;
  return claims;
}

/**
 * Constant-time string comparison over fixed-length SHA-256 digests, so neither
 * the content nor the length of the account password is leaked by timing.
 */
export async function constantTimeEqual(
  a: string,
  b: string,
): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a) as BufferSource),
    crypto.subtle.digest("SHA-256", encoder.encode(b) as BufferSource),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++)
    diff |= (va[i] as number) ^ (vb[i] as number);
  return diff === 0;
}
