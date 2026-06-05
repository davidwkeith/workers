/**
 * The per-relying-party Durable Object: the single-threaded consistency
 * authority for WebAuthn challenge state and credential records.
 *
 * The stateless front door (`handler.ts`) routes a ceremony step to this object
 * via the {@link INTERNAL_HEADERS.op} header and the request body; everything
 * that must be strongly consistent — minting and single-use consumption of
 * short-TTL challenges, and reading/writing credential records (public key,
 * signature counter, transports) — happens here, where Cloudflare guarantees a
 * single thread per relying party. Challenge and credential state are kept in DO
 * SQLite (never KV: a stale challenge or counter is a security bug). Consumers
 * bind this class as a Durable Object namespace.
 */

import { DurableObject } from "cloudflare:workers";

import {
  INTERNAL_HEADERS,
  type ForwardedConfig,
  type WebAuthnEnv,
} from "./config";
import { base64urlToBytes, bytesToBase64url } from "./encoding";
import { WebAuthnLogEvent } from "./log";
import {
  verifyAuthentication,
  verifyRegistration,
  type VerifyFailureReason,
} from "./verify";

/** A stored challenge row. */
type ChallengeRow = {
  challenge: string;
  type: string;
  user_id: string | null;
  expires_at: number;
};

/** A stored credential row. */
type CredentialRow = {
  credential_id: string;
  user_id: string;
  public_key: string;
  alg: number;
  counter: number;
  transports: string | null;
};

/** Number of random bytes in a challenge (WebAuthn recommends ≥16). */
const CHALLENGE_BYTES = 32;
/** Random bytes minted for a generated user handle. */
const USER_HANDLE_BYTES = 16;

export class WebAuthnObject extends DurableObject<WebAuthnEnv> {
  readonly #sql: SqlStorage;

  constructor(state: DurableObjectState, env: WebAuthnEnv) {
    super(state, env);
    this.#sql = state.storage.sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS challenges (
         challenge  TEXT PRIMARY KEY,
         type       TEXT NOT NULL,
         user_id    TEXT,
         expires_at INTEGER NOT NULL
       )`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS credentials (
         credential_id TEXT PRIMARY KEY,
         user_id       TEXT NOT NULL,
         public_key    TEXT NOT NULL,
         alg           INTEGER NOT NULL,
         counter       INTEGER NOT NULL,
         transports    TEXT
       )`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS credentials_user_id ON credentials (user_id)`,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const op = request.headers.get(INTERNAL_HEADERS.op);
    const config = this.#readConfig(request);
    const now = Number(request.headers.get(INTERNAL_HEADERS.now)) || Date.now();
    const body = await readJsonObject(request);
    if (config === null) return badRequest("missing config");

    switch (op) {
      case "register/options":
        return this.#registerOptions(config, now, body);
      case "register/verify":
        return this.#registerVerify(config, now, body);
      case "authenticate/options":
        return this.#authenticateOptions(config, now, body);
      case "authenticate/verify":
        return this.#authenticateVerify(config, now, body);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  #readConfig(request: Request): ForwardedConfig | null {
    const raw = request.headers.get(INTERNAL_HEADERS.config);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ForwardedConfig;
    } catch {
      return null;
    }
  }

  // -- registration ----------------------------------------------------------

  #registerOptions(
    config: ForwardedConfig,
    now: number,
    body: Record<string, unknown>,
  ): Response {
    const user = isObject(body.user) ? body.user : {};
    const userId =
      typeof user.id === "string" && user.id.length > 0
        ? user.id
        : bytesToBase64url(randomBytes(USER_HANDLE_BYTES));
    const name = typeof user.name === "string" ? user.name : "user";
    const displayName =
      typeof user.displayName === "string" ? user.displayName : name;

    const challenge = this.#mintChallenge("registration", userId, config, now);

    const options = {
      challenge,
      rp: { id: config.rpId, name: config.rpName },
      user: { id: userId, name, displayName },
      pubKeyCredParams: config.algorithms.map((alg) => ({
        type: "public-key",
        alg,
      })),
      timeout: config.timeoutMs,
      attestation: "none",
      authenticatorSelection: {
        userVerification: config.userVerification,
        residentKey: "preferred",
      },
      excludeCredentials: this.#credentialDescriptors(userId),
    };
    return ok(options, WebAuthnLogEvent.RegisterOptions);
  }

  async #registerVerify(
    config: ForwardedConfig,
    now: number,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const response = isObject(body.response) ? body.response : null;
    const clientDataB64 = response?.clientDataJSON;
    const attestationB64 = response?.attestationObject;
    if (
      typeof clientDataB64 !== "string" ||
      typeof attestationB64 !== "string"
    ) {
      return rejected(WebAuthnLogEvent.RegisterRejected, "bad_request");
    }

    const clientDataJSON = decode(clientDataB64);
    const attestationObject = decode(attestationB64);
    if (clientDataJSON === null || attestationObject === null) {
      return rejected(WebAuthnLogEvent.RegisterRejected, "bad_request");
    }

    const row = this.#consumeChallenge(clientDataJSON, "registration", now);
    if (row === null) {
      return rejected(WebAuthnLogEvent.RegisterRejected, "challenge_mismatch");
    }

    const result = await verifyRegistration({
      attestationObject,
      clientDataJSON,
      expectedChallenge: row.challenge,
      expectedOrigins: config.origins,
      expectedRpId: config.rpId,
      requireUserVerification: config.userVerification === "required",
    });
    if (!result.verified) {
      return rejected(WebAuthnLogEvent.RegisterRejected, result.reason);
    }

    const userId = row.user_id ?? "";
    const transports = normalizeTransports(
      response?.transports ?? body.transports,
    );
    try {
      this.#sql.exec(
        `INSERT INTO credentials
           (credential_id, user_id, public_key, alg, counter, transports)
         VALUES (?, ?, ?, ?, ?, ?)`,
        result.credential.id,
        userId,
        JSON.stringify(result.credential.publicKeyJwk),
        result.credential.alg,
        result.credential.counter,
        transports === null ? null : JSON.stringify(transports),
      );
    } catch {
      // PRIMARY KEY conflict: this credential is already registered.
      return rejected(WebAuthnLogEvent.RegisterRejected, "credential_exists");
    }

    return ok(
      {
        verified: true,
        credentialId: result.credential.id,
        userId,
        aaguid: result.credential.aaguid,
      },
      WebAuthnLogEvent.RegisterVerified,
    );
  }

  // -- authentication --------------------------------------------------------

  #authenticateOptions(
    config: ForwardedConfig,
    now: number,
    body: Record<string, unknown>,
  ): Response {
    const userId = typeof body.userId === "string" ? body.userId : null;
    const challenge = this.#mintChallenge(
      "authentication",
      userId,
      config,
      now,
    );

    const options: Record<string, unknown> = {
      challenge,
      timeout: config.timeoutMs,
      rpId: config.rpId,
      userVerification: config.userVerification,
    };
    // With a known user we scope the assertion to their credentials; without
    // one we omit allowCredentials so a discoverable credential can be used.
    if (userId !== null) {
      options.allowCredentials = this.#credentialDescriptors(userId);
    }
    return ok(options, WebAuthnLogEvent.AuthenticateOptions);
  }

  async #authenticateVerify(
    config: ForwardedConfig,
    now: number,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const response = isObject(body.response) ? body.response : null;
    const clientDataB64 = response?.clientDataJSON;
    const authDataB64 = response?.authenticatorData;
    const signatureB64 = response?.signature;
    const credentialId = typeof body.id === "string" ? body.id : body.rawId;
    if (
      typeof clientDataB64 !== "string" ||
      typeof authDataB64 !== "string" ||
      typeof signatureB64 !== "string" ||
      typeof credentialId !== "string"
    ) {
      return rejected(WebAuthnLogEvent.AuthenticateRejected, "bad_request");
    }

    const clientDataJSON = decode(clientDataB64);
    const authenticatorData = decode(authDataB64);
    const signature = decode(signatureB64);
    if (
      clientDataJSON === null ||
      authenticatorData === null ||
      signature === null
    ) {
      return rejected(WebAuthnLogEvent.AuthenticateRejected, "bad_request");
    }

    const row = this.#consumeChallenge(clientDataJSON, "authentication", now);
    if (row === null) {
      return rejected(
        WebAuthnLogEvent.AuthenticateRejected,
        "challenge_mismatch",
      );
    }

    const credential = this.#sql
      .exec<CredentialRow>(
        "SELECT * FROM credentials WHERE credential_id = ?",
        credentialId,
      )
      .toArray()[0];
    if (!credential) {
      return rejected(WebAuthnLogEvent.AuthenticateRejected, "no_credential");
    }
    // When the ceremony was scoped to a user, the asserted credential MUST be
    // one of theirs.
    if (row.user_id !== null && credential.user_id !== row.user_id) {
      return rejected(WebAuthnLogEvent.AuthenticateRejected, "no_credential");
    }

    const result = await verifyAuthentication({
      authenticatorData,
      clientDataJSON,
      signature,
      expectedChallenge: row.challenge,
      expectedOrigins: config.origins,
      expectedRpId: config.rpId,
      requireUserVerification: config.userVerification === "required",
      credentialPublicKeyJwk: JSON.parse(credential.public_key) as JsonWebKey,
      credentialAlg: credential.alg,
      storedCounter: credential.counter,
    });
    if (!result.verified) {
      return rejected(WebAuthnLogEvent.AuthenticateRejected, result.reason);
    }

    this.#sql.exec(
      "UPDATE credentials SET counter = ? WHERE credential_id = ?",
      result.newCounter,
      credentialId,
    );

    return ok(
      {
        verified: true,
        credentialId,
        userId: credential.user_id,
      },
      WebAuthnLogEvent.AuthenticateVerified,
    );
  }

  // -- challenge state -------------------------------------------------------

  /** Mint, store, and return a fresh challenge; prune expired rows first. */
  #mintChallenge(
    type: "registration" | "authentication",
    userId: string | null,
    config: ForwardedConfig,
    now: number,
  ): string {
    this.#sql.exec("DELETE FROM challenges WHERE expires_at < ?", now);
    const challenge = bytesToBase64url(randomBytes(CHALLENGE_BYTES));
    this.#sql.exec(
      `INSERT INTO challenges (challenge, type, user_id, expires_at)
       VALUES (?, ?, ?, ?)`,
      challenge,
      type,
      userId,
      now + config.challengeTtlSeconds * 1000,
    );
    return challenge;
  }

  /**
   * Find the stored challenge named in `clientDataJSON`, of the expected type
   * and unexpired, and delete it (single use). Returns the row or `null` when no
   * live matching challenge exists. The challenge is consumed even on a later
   * verification failure, so a captured ceremony cannot be replayed.
   */
  #consumeChallenge(
    clientDataJSON: Uint8Array,
    type: "registration" | "authentication",
    now: number,
  ): ChallengeRow | null {
    let challenge: string;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(clientDataJSON)) as {
        challenge?: unknown;
      };
      if (typeof parsed.challenge !== "string") return null;
      challenge = parsed.challenge;
    } catch {
      return null;
    }

    const row = this.#sql
      .exec<ChallengeRow>(
        "SELECT * FROM challenges WHERE challenge = ? AND type = ?",
        challenge,
        type,
      )
      .toArray()[0];
    if (!row) return null;
    this.#sql.exec("DELETE FROM challenges WHERE challenge = ?", challenge);
    if (row.expires_at < now) return null;
    return row;
  }

  /** Build the credential-descriptor list for a user (exclude / allow lists). */
  #credentialDescriptors(
    userId: string,
  ): { type: "public-key"; id: string; transports?: string[] }[] {
    return this.#sql
      .exec<CredentialRow>(
        "SELECT * FROM credentials WHERE user_id = ?",
        userId,
      )
      .toArray()
      .map((row) => {
        const transports = parseTransports(row.transports);
        return {
          type: "public-key" as const,
          id: row.credential_id,
          ...(transports ? { transports } : {}),
        };
      });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64url-decode a field, returning `null` if it is not decodable. */
function decode(input: string): Uint8Array | null {
  try {
    return base64urlToBytes(input);
  } catch {
    return null;
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Coerce a client-supplied transports value to a string array, or `null`. */
function normalizeTransports(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const transports = value.filter((t): t is string => typeof t === "string");
  return transports.length > 0 ? transports : null;
}

/** Parse the stored transports JSON back to an array, or `null`. */
function parseTransports(stored: string | null): string[] | null {
  if (stored === null) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return normalizeTransports(parsed);
  } catch {
    return null;
  }
}

/** A `200` JSON response carrying the ceremony outcome event for the front door. */
function ok(body: unknown, event: WebAuthnLogEvent): Response {
  return json(200, body, { [INTERNAL_HEADERS.event]: event });
}

/** A `400` JSON rejection carrying the outcome event and a stable reason. */
function rejected(
  event: WebAuthnLogEvent,
  reason: VerifyFailureReason | string,
): Response {
  return json(
    400,
    { verified: false, error: reason },
    { [INTERNAL_HEADERS.event]: event, [INTERNAL_HEADERS.reason]: reason },
  );
}

function badRequest(message: string): Response {
  return json(400, { error: message });
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
