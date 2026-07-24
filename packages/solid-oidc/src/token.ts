/**
 * Mint the two JWTs a Solid-OIDC token response carries: a DPoP-bound access
 * token and an OpenID Connect ID token, both ES256-signed by the OP key.
 *
 * The access-token claim set is dictated by what a Solid Resource Server
 * validates (`@dwk/solid-pod`'s `auth.ts`): `iss` (= the OP issuer), a `webid`
 * URL, an `aud` that intersects the pod's accepted set (`"solid"` plus the
 * pod origin), `cnf.jkt` (the DPoP key thumbprint), `exp`, and the RFC 9068
 * `typ: "at+jwt"` header. Get any of these wrong and the pod rejects the token.
 *
 * @packageDocumentation
 */

import { randomToken } from "./encoding.js";
import { signJws, type SigningKey } from "./jws.js";

/** Inputs for {@link mintAccessToken}. */
export interface AccessTokenInput {
  /** OP issuer (the value a pod matches against its configured `iss`). */
  readonly issuer: string;
  /** The authenticated agent's WebID URL. */
  readonly webid: string;
  /** The client the token was issued to. */
  readonly clientId: string;
  /** Space-separated granted scope. */
  readonly scope: string;
  /** RFC 9449 DPoP key thumbprint to bind (`cnf.jkt`). */
  readonly jkt: string;
  /**
   * Resource-server audience(s) (RFC 8707). Solid pods accept a token whose
   * `aud` intersects their set (default `["solid", <pod origin>]`), so include
   * `"solid"` and/or the target pod origin.
   */
  readonly audience: readonly string[];
  /** Access-token lifetime in seconds. */
  readonly lifetimeSeconds: number;
  /** Current epoch seconds. */
  readonly now: number;
}

/** Inputs for {@link mintIdToken}. */
export interface IdTokenInput {
  readonly issuer: string;
  readonly webid: string;
  readonly clientId: string;
  readonly lifetimeSeconds: number;
  readonly now: number;
  /** The client's `nonce` from the authorization request, echoed back. */
  readonly nonce?: string;
}

/**
 * Mint a DPoP-bound ES256 access token (RFC 9068 `at+jwt`). The subject is the
 * WebID: Solid-OIDC identifies the agent by `webid` (with `sub` mirrored for
 * plain-OAuth consumers), and the pod reads `webid` first.
 */
export async function mintAccessToken(
  key: SigningKey,
  input: AccessTokenInput,
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const jti = randomToken();
  const expiresAt = input.now + input.lifetimeSeconds;
  const token = await signJws(
    key,
    { typ: "at+jwt" },
    {
      iss: input.issuer,
      sub: input.webid,
      webid: input.webid,
      aud: [...input.audience],
      client_id: input.clientId,
      scope: input.scope,
      cnf: { jkt: input.jkt },
      iat: input.now,
      exp: expiresAt,
      jti,
    },
  );
  return { token, jti, expiresAt };
}

/**
 * Mint an OIDC ID token. `aud` is the client; the subject is the WebID and a
 * `webid` claim is carried explicitly (Solid-OIDC). `nonce` is echoed when the
 * authorization request supplied one.
 */
export async function mintIdToken(
  key: SigningKey,
  input: IdTokenInput,
): Promise<string> {
  return signJws(
    key,
    { typ: "JWT" },
    {
      iss: input.issuer,
      sub: input.webid,
      webid: input.webid,
      aud: input.clientId,
      azp: input.clientId,
      iat: input.now,
      exp: input.now + input.lifetimeSeconds,
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    },
  );
}
