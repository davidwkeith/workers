/**
 * The per-account repository Durable Object: the single-threaded authority for
 * one AT Protocol repository.
 *
 * The stateless front door (`handler.ts`) routes the XRPC surface and the
 * identity documents here; everything that must be strongly consistent lives in
 * this object, where Cloudflare guarantees one writer per account: the repository
 * **signing key** (generated here, never emitted), the record set, the
 * deterministic **MST**, and the signed **commit chain**. For a `did:plc`
 * account it also holds a DO-custodied rotation key and derives the account's
 * `did:plc` from a self-signed genesis operation at init. Records are kept in
 * SQLite and the MST is rebuilt deterministically on each commit and each CAR
 * export. Blob bodies stream to R2. Consumers bind this class as a Durable
 * Object namespace.
 */

import { DurableObject } from "cloudflare:workers";

import {
  constantTimeEqual,
  signJwt,
  verifyJwt,
  type SessionClaims,
} from "./auth.js";
import { writeCar, writeCarStream, type CarBlock } from "./car.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC, RAW_CODEC } from "./cid.js";
import {
  encodeAccountFrame,
  encodeCommitFrame,
  encodeErrorFrame,
  encodeIdentityFrame,
  encodeInfoFrame,
  type FirehoseRepoOp,
} from "./firehose.js";
import {
  INTERNAL_CONFIG_HEADER,
  type AtprotoPdsEnv,
  type ForwardedConfig,
} from "./config.js";
import {
  createRepoKeypair,
  didKeyFromPublicKey,
  loadSigner,
  publicKeyMultibase,
  type RepoKeypair,
  type SigningCurve,
  type Signer,
} from "./crypto.js";
import { buildDidDocument, isValidHandle } from "./identity.js";
import { importRepoFromCar } from "./migrate.js";
import { submitPlcOperation } from "./plc-directory.js";
import { resolveSigningKey } from "./resolve.js";
import {
  didPlcFromGenesis,
  signPlcOperation,
  type SignedPlcOperation,
  type UnsignedPlcOperation,
} from "./plc.js";
import { buildMst, type MstEntry } from "./mst.js";
import {
  atUri,
  cborToJson,
  extractBlobCids,
  jsonToCbor,
  recordPath,
  type JsonValue,
} from "./record.js";
import { formatCommit } from "./repo.js";
import { TidClock } from "./tid.js";
import {
  authRequired,
  errorResponse,
  forbidden,
  invalidRequest,
  isValidNsid,
  isValidRecordKey,
  jsonResponse,
  namedError,
} from "./xrpc.js";

const ACCESS_SCOPE = "com.atproto.access";
const REFRESH_SCOPE = "com.atproto.refresh";
const CAR_CONTENT_TYPE = "application/vnd.ipld.car";

// Content types safe to serve inline with their declared type when a public,
// unauthenticated blob is fetched. The upload's content type is
// client-controlled, so anything else (notably text/html, image/svg+xml) is
// served as an opaque downloaded blob to prevent stored XSS on the account's
// own origin.
const SAFE_INLINE_BLOB_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
]);

// Pseudo-codes the runtime reports for how a connection ended but that the
// WebSocket spec forbids sending back to the peer via `ws.close()`.
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

// Firehose backfill retention: the most recent N `#commit` frames are buffered
// in DO SQLite so a reconnecting consumer can replay from a `?cursor=` before
// going live. Older frames are trimmed; a cursor older than the window receives
// an `OutdatedCursor` info frame, then whatever remains in the buffer.
const FIREHOSE_RETENTION = 1024;

// Ceiling on total bytes sent by one #backfill replay (§ subscribeRepos).
// Without this, the worst case is FIREHOSE_RETENTION frames at up to 1 MiB
// each — up to ~1 GiB queued onto the socket in one synchronous burst, with
// no flow control, since Workers' WebSocket exposes no `bufferedAmount` (or
// any other backpressure signal) to gate on — unlike the standard browser
// WebSocket API its types otherwise mirror. Capping the total instead bounds
// the burst regardless of how fast the client drains it; a client that hits
// the cap gets a terminal error and reconnects with a narrower cursor.
const MAX_BACKFILL_BYTES = 16 * 1024 * 1024; // 16 MiB

// PLC genesis submission retry schedule (alarm-driven exponential backoff).
const PLC_SUBMIT_MAX_ATTEMPTS = 10;
const PLC_SUBMIT_BASE_MS = 10_000; // 10s
const PLC_SUBMIT_CAP_MS = 3_600_000; // 1h

/** Backoff delay before the Nth PLC-submission retry (1-based), capped. */
export function plcRetryDelayMs(attempt: number): number {
  return Math.min(PLC_SUBMIT_BASE_MS * 2 ** (attempt - 1), PLC_SUBMIT_CAP_MS);
}

/** Parse a `limit` query param, applying a default and clamping to [1, max]. */
function clampLimit(raw: string | null, fallback: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, n));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Yield every record's block, decoding one row at a time from the SQL cursor
 * as the generator is advanced (never `.toArray()`d), so a `getRepo` export
 * streamed through {@link writeCarStream} holds at most one decoded record
 * body in memory at once instead of the whole repository.
 */
function* repoRecordBlocks(sql: SqlStorage): Generator<CarBlock> {
  for (const row of sql.exec("SELECT cid, value FROM records")) {
    yield {
      cid: CID.parse(row.cid as string),
      bytes: unbase64(row.value as string),
    };
  }
}

/** The full block set for a `getRepo` export CAR: the signed commit, every MST
 * node (already resident in memory from the `buildMst` call), then every
 * record body streamed lazily via {@link repoRecordBlocks}. */
function* repoBlocks(
  headCid: CID,
  headBytes: Uint8Array,
  nodeBlocks: ReadonlyMap<string, Uint8Array>,
  sql: SqlStorage,
): Generator<CarBlock> {
  yield { cid: headCid, bytes: headBytes };
  for (const [cidStr, bytes] of nodeBlocks) {
    yield { cid: CID.parse(cidStr), bytes };
  }
  yield* repoRecordBlocks(sql);
}

export class AtprotoRepoObject extends DurableObject<AtprotoPdsEnv> {
  readonly #sql: SqlStorage;
  readonly #tid = new TidClock();
  #config: ForwardedConfig | null = null;
  #signerFn: Signer | null = null;
  #accountDidCache: string | null = null;
  // The signing curve and raw public key are fixed at genesis, so cache them to
  // avoid a SQLite read on every identity request (they are read several times).
  #signingCurveCache: SigningCurve | null = null;
  #publicKeyRawCache: Uint8Array | null = null;
  // The effective handle: an `updateHandle` override if set, else the configured
  // one. Cached and invalidated on update to avoid a SQLite read per identity
  // request (it is read several times — sessions, DID doc, resolveHandle).
  #handleCache: string | null = null;
  #initPromise: Promise<void> | null = null;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState, env: AtprotoPdsEnv) {
    super(state, env);
    // DO SQLite is opt-in; without it `state.storage.sql` is undefined and every
    // query would throw an opaque TypeError. Fail loudly with the fix instead.
    if (!state.storage.sql) {
      throw new Error(
        "@dwk/atproto-pds: Durable Object SQLite is not enabled — bind " +
          "AtprotoRepoObject with `useSQLite: true` (a `new_sqlite_classes` migration)",
      );
    }
    this.#sql = state.storage.sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS records (
         collection TEXT NOT NULL, rkey TEXT NOT NULL, cid TEXT NOT NULL,
         value TEXT NOT NULL, indexed_at INTEGER NOT NULL,
         PRIMARY KEY (collection, rkey))`,
    );
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS blobs (
         cid TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL,
         created_at INTEGER NOT NULL)`,
    );
    // Index of blob CIDs each record references, so the referenced-blob set is a
    // cheap `SELECT DISTINCT` rather than a scan-and-decode of every record.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS record_blobs (
         collection TEXT NOT NULL, rkey TEXT NOT NULL, blob_cid TEXT NOT NULL,
         PRIMARY KEY (collection, rkey, blob_cid))`,
    );
    // Bounded ring of recent firehose frames (base64 DAG-CBOR), keyed by their
    // monotonic `seq`, for `?cursor=` backfill on (re)connect.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS firehose (
         seq INTEGER PRIMARY KEY, frame TEXT NOT NULL)`,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const header = request.headers.get(INTERNAL_CONFIG_HEADER);
    if (!header) {
      return new Response("missing internal config", { status: 500 });
    }
    try {
      // Parse inside the guard so a corrupt internal header yields a clean,
      // logged error envelope rather than an unhandled 500.
      this.#config = JSON.parse(header) as ForwardedConfig;
      await this.#ensureRepo();
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/atproto-did") {
        return new Response(this.#accountDid(), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.pathname === "/.well-known/did.json") {
        return this.#serveDidDocument();
      }
      const xrpc = url.pathname.match(/^\/xrpc\/([^/]+)$/);
      if (!xrpc) return jsonResponse({ error: "NotFound" }, 404);
      const nsid = xrpc[1] as string;
      // The firehose is a WebSocket subscription, not a request/response XRPC
      // call, so it is handled before the JSON dispatch table.
      if (nsid === "com.atproto.sync.subscribeRepos") {
        return this.#subscribeRepos(request, url);
      }
      return await this.#dispatch(nsid, request, url);
    } catch (error) {
      return errorResponse(error);
    }
  }

  // --- repository lifecycle -------------------------------------------------

  get #cfg(): ForwardedConfig {
    if (!this.#config) throw new Error("config not set");
    return this.#config;
  }

  /**
   * Lazily generate the signing key and the genesis (empty) commit, exactly
   * once. DOs interleave concurrent requests at `await` points, so the first
   * caller's init must complete before any other proceeds — otherwise two
   * requests could each generate a key and genesis commit and corrupt the repo.
   * A cached init promise serialises them; a failure clears it so a later
   * request can retry.
   */
  async #ensureRepo(): Promise<void> {
    if (!this.#initPromise) {
      this.#initPromise = this.#initRepo().catch((error) => {
        this.#initPromise = null;
        throw error;
      });
    }
    return this.#initPromise;
  }

  async #initRepo(): Promise<void> {
    const existing = this.#kvGet("signing_key");
    if (existing) return;
    // The curve is chosen at genesis from config and then fixed: it is recorded
    // alongside the key so verification and the DID document never have to guess
    // it from raw key bytes (P-256 and secp256k1 keys are both 65 bytes raw).
    const keypair = await createRepoKeypair(this.#cfg.signingCurve);
    this.#kvSet("signing_curve", keypair.curve);
    this.#kvSet("signing_key", keypair.privateKeyExport);
    this.#kvSet("pubkey_raw", base64(keypair.publicKeyRaw));
    this.#signerFn = await loadSigner(keypair.curve, keypair.privateKeyExport);
    // Resolve the account DID before the genesis commit, since the commit is
    // signed over it. did:web is known from config; a fresh did:plc is derived
    // here from a self-signed genesis operation (and an adopted did:plc, e.g.
    // from migration, is taken as-is).
    this.#kvSet("account_did", await this.#resolveAccountDid(keypair));
    await this.#commit();
    await this.#schedulePlcSubmission();
  }

  /**
   * Arm the alarm-driven registration of a freshly minted `did:plc` with the
   * directory. Only when a directory URL is configured and a genesis operation
   * was minted here (not for `did:web`, nor an adopted/migrated DID). The URL is
   * persisted so the alarm — which runs without a request, hence without config —
   * can submit independently. Registration is never on the request path.
   */
  async #schedulePlcSubmission(): Promise<void> {
    const directoryUrl = this.#cfg.plcDirectoryUrl;
    if (
      !directoryUrl ||
      !this.#kvGet("plc_genesis") ||
      this.#kvGet("plc_submitted")
    ) {
      return;
    }
    this.#kvSet("plc_directory_url", directoryUrl);
    // Fire as soon as possible; failures reschedule with backoff in alarm().
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Alarm handler: drives PLC genesis submission with exponential backoff until
   * the directory accepts it (or {@link PLC_SUBMIT_MAX_ATTEMPTS} is exhausted).
   * Runs without request config, so it reads everything it needs from storage.
   */
  override async alarm(): Promise<void> {
    await this.#runPlcSubmission();
  }

  async #runPlcSubmission(): Promise<void> {
    const directoryUrl = this.#kvGet("plc_directory_url") as string | null;
    const genesis = this.#kvGet("plc_genesis") as string | null;
    const did = this.#kvGet("account_did") as string | null;
    if (!directoryUrl || !genesis || !did || this.#kvGet("plc_submitted")) {
      return;
    }
    try {
      await submitPlcOperation(did, JSON.parse(genesis) as SignedPlcOperation, {
        directoryUrl,
      });
      this.#kvSet("plc_submitted", "1");
    } catch (error) {
      const attempts = Number(this.#kvGet("plc_attempts") ?? "0") + 1;
      this.#kvSet("plc_attempts", String(attempts));
      if (attempts >= PLC_SUBMIT_MAX_ATTEMPTS) {
        console.warn(
          `@dwk/atproto-pds: PLC genesis submission gave up after ${attempts} attempts (needs a manual re-submit): ${String(error)}`,
        );
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + plcRetryDelayMs(attempts));
    }
  }

  /** Determine and persist the account DID at genesis (see {@link #initRepo}). */
  async #resolveAccountDid(signing: RepoKeypair): Promise<string> {
    const cfg = this.#cfg;
    if (cfg.didMethod !== "plc") return cfg.did;
    // Adopt a pre-existing did:plc (migration) rather than minting a new one.
    if (cfg.did) return cfg.did;
    return this.#createPlcGenesis(signing);
  }

  /**
   * Mint a fresh `did:plc`: generate a DO-custodied secp256k1 rotation key, sign
   * a genesis operation with it, derive the DID, and persist both. The rotation
   * key never leaves the DO — like the signing key, custody stays as tight as
   * possible. Directory submission is a separate concern (not yet wired).
   */
  async #createPlcGenesis(signing: RepoKeypair): Promise<string> {
    const cfg = this.#cfg;
    const rotation = await createRepoKeypair("secp256k1");
    const op: UnsignedPlcOperation = {
      type: "plc_operation",
      rotationKeys: [didKeyFromPublicKey(rotation.publicKeyRaw, "secp256k1")],
      verificationMethods: {
        atproto: didKeyFromPublicKey(signing.publicKeyRaw, signing.curve),
      },
      alsoKnownAs: [`at://${cfg.handle}`],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: cfg.baseUrl,
        },
      },
      prev: null,
    };
    const rotationSigner = await loadSigner(
      "secp256k1",
      rotation.privateKeyExport,
    );
    const signed = await signPlcOperation(op, rotationSigner);
    this.#kvSet("rotation_curve", "secp256k1");
    this.#kvSet("rotation_key", rotation.privateKeyExport);
    this.#kvSet("plc_genesis", JSON.stringify(signed));
    return didPlcFromGenesis(signed);
  }

  /**
   * The authoritative account DID (derived at genesis), falling back to config.
   * Memoised: `account_did` is immutable once written, so a single SQLite read
   * per DO instance suffices even though this is called several times per request
   * (auth, commit signing, `at://` URIs).
   */
  #accountDid(): string {
    if (this.#accountDidCache !== null) return this.#accountDidCache;
    const stored = this.#kvGet("account_did") as string | null;
    if (stored !== null) {
      this.#accountDidCache = stored;
      return stored;
    }
    return this.#cfg.did;
  }

  /** The curve this repository was initialised with (authoritative, persisted). */
  #signingCurve(): SigningCurve {
    if (this.#signingCurveCache === null) {
      this.#signingCurveCache =
        (this.#kvGet("signing_curve") as SigningCurve | null) ?? "p256";
    }
    return this.#signingCurveCache;
  }

  async #signer(): Promise<Signer> {
    if (!this.#signerFn) {
      this.#signerFn = await loadSigner(
        this.#signingCurve(),
        this.#kvGet("signing_key") as string,
      );
    }
    return this.#signerFn;
  }

  #publicKeyRaw(): Uint8Array {
    if (this.#publicKeyRawCache === null) {
      this.#publicKeyRawCache = unbase64(this.#kvGet("pubkey_raw") as string);
    }
    return this.#publicKeyRawCache;
  }

  // --- XRPC dispatch --------------------------------------------------------

  async #dispatch(nsid: string, request: Request, url: URL): Promise<Response> {
    switch (nsid) {
      case "com.atproto.server.createSession":
        return this.#createSession(request);
      case "com.atproto.server.getSession":
        return this.#getSession(request);
      case "com.atproto.server.refreshSession":
        return this.#refreshSession(request);
      case "com.atproto.server.activateAccount":
        return this.#setAccountActive(request, true);
      case "com.atproto.server.deactivateAccount":
        return this.#setAccountActive(request, false);
      case "com.atproto.server.checkAccountStatus":
        return this.#checkAccountStatus(request);
      case "com.atproto.server.describeServer":
        return jsonResponse({
          did: this.#accountDid(),
          availableUserDomains: [],
        });
      case "com.atproto.identity.resolveHandle":
        return this.#resolveHandle(url);
      case "com.atproto.identity.updateHandle":
        // A mutation that emits an `#identity` firehose event — serialize it on
        // the write chain like the record mutations below.
        return this.#enqueueWrite(() => this.#updateHandle(request));
      case "com.atproto.identity.getRecommendedDidCredentials":
        return this.#getRecommendedDidCredentials(request);
      case "com.atproto.repo.describeRepo":
        return this.#describeRepo();
      // The four commit-chain mutations are serialized through the write queue:
      // each reads the prior head and chains a new commit onto it, so they must
      // not interleave at `await` points (which would fork the chain).
      case "com.atproto.repo.createRecord":
        return this.#enqueueWrite(() => this.#createRecord(request));
      case "com.atproto.repo.putRecord":
        return this.#enqueueWrite(() => this.#putRecord(request));
      case "com.atproto.repo.deleteRecord":
        return this.#enqueueWrite(() => this.#deleteRecord(request));
      case "com.atproto.repo.importRepo":
        return this.#enqueueWrite(() => this.#importRepo(request));
      case "com.atproto.repo.getRecord":
        return this.#getRecord(url);
      case "com.atproto.repo.listRecords":
        return this.#listRecords(url);
      case "com.atproto.repo.uploadBlob":
        return this.#uploadBlob(request);
      case "com.atproto.repo.listMissingBlobs":
        return this.#listMissingBlobs(request);
      case "com.atproto.sync.getRepo":
        return this.#getRepo();
      case "com.atproto.sync.getLatestCommit":
        return this.#getLatestCommit();
      case "com.atproto.sync.getBlob":
        return this.#getBlob(url);
      case "com.atproto.sync.getRepoStatus":
        return this.#getRepoStatus(url);
      case "com.atproto.sync.listBlobs":
        return this.#listBlobs(url);
      case "com.atproto.sync.listRepos":
        return jsonResponse({
          repos: [
            {
              did: this.#accountDid(),
              head: this.#kvGet("head_cid"),
              rev: this.#kvGet("head_rev"),
              active: this.#isActive(),
            },
          ],
        });
      default:
        return jsonResponse(
          { error: "MethodNotImplemented", message: nsid },
          501,
        );
    }
  }

  // --- account status (migration cutover) -----------------------------------

  /** Whether the account is active here (the default), or deactivated. */
  #isActive(): boolean {
    return this.#kvGet("deactivated") !== "1";
  }

  /**
   * Toggle the account's active state (`activateAccount` / `deactivateAccount`).
   * This is the network-coordination switch for migration: a Relay reads
   * `getRepoStatus` to decide whether to crawl this PDS, so the cutover
   * deactivates the old home and activates the new one.
   */
  async #setAccountActive(
    request: Request,
    active: boolean,
  ): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    // Serialize through the write chain like every other mutation, so this
    // status change and its `#account` event take a deterministic place in the
    // single firehose order relative to concurrent `#commit`s (and stay correct
    // even if event emission ever gains an `await`).
    return this.#enqueueWrite(async () => {
      const changed = this.#isActive() !== active;
      if (active) this.#kvSet("deactivated", "0");
      else this.#kvSet("deactivated", "1");
      // Announce the cutover on the firehose, but only on a real transition so a
      // repeated activate/deactivate does not emit redundant events.
      if (changed) this.#emitAccount(active);
      return jsonResponse({ did: this.#accountDid(), active });
    });
  }

  /** Report the account's status to its owner (`checkAccountStatus`). */
  async #checkAccountStatus(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const count = (
      this.#sql.exec("SELECT COUNT(*) AS n FROM records").toArray()[0] as {
        n: number;
      }
    ).n;
    const referenced = this.#referencedBlobCids();
    const held = this.#heldBlobCids();
    let importedBlobs = 0;
    for (const cid of referenced) if (held.has(cid)) importedBlobs++;
    return jsonResponse({
      activated: this.#isActive(),
      validDid: true,
      repoCommit: this.#kvGet("head_cid"),
      repoRev: this.#kvGet("head_rev"),
      indexedRecords: count,
      expectedBlobs: referenced.size,
      importedBlobs,
    });
  }

  /**
   * Recommend the DID credentials that point this account at *this* PDS
   * (`com.atproto.identity.getRecommendedDidCredentials`). During migration the
   * client builds a PLC operation from these — our signing key, our endpoint, and
   * our rotation key (for a `did:plc` we minted) — and signs it with a rotation
   * key it controls, completing the move. We never hold a migrated account's
   * rotation key, so we recommend, not sign.
   */
  async #getRecommendedDidCredentials(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const cfg = this.#cfg;
    const genesis = this.#kvGet("plc_genesis");
    const rotationKeys = genesis
      ? [...(JSON.parse(genesis) as SignedPlcOperation).rotationKeys]
      : [];
    return jsonResponse({
      rotationKeys,
      alsoKnownAs: [`at://${this.#handle()}`],
      verificationMethods: {
        atproto: didKeyFromPublicKey(
          this.#publicKeyRaw(),
          this.#signingCurve(),
        ),
      },
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: cfg.baseUrl,
        },
      },
    });
  }

  /** Public repository status (`getRepoStatus`) — what Relays poll at cutover. */
  #getRepoStatus(url: URL): Response {
    const did = url.searchParams.get("did");
    if (!did) throw invalidRequest("`did` is required");
    if (did !== this.#accountDid()) {
      throw namedError(404, "RepoNotFound", "Repo not hosted on this server");
    }
    const active = this.#isActive();
    return jsonResponse({
      did: this.#accountDid(),
      active,
      ...(active ? {} : { status: "deactivated" }),
      rev: this.#kvGet("head_rev"),
    });
  }

  // --- sessions -------------------------------------------------------------

  async #createSession(request: Request): Promise<Response> {
    const cfg = this.#cfg;
    if (!cfg.password || !cfg.jwtSecret) {
      throw forbidden("This server does not accept sessions");
    }
    const body = (await request.json()) as {
      identifier?: string;
      password?: string;
    };
    if (!body.password) throw invalidRequest("`password` is required");
    if (!(await constantTimeEqual(body.password, cfg.password))) {
      throw namedError(
        401,
        "AuthenticationFailed",
        "Invalid identifier or password",
      );
    }
    const tokens = await this.#issueTokens();
    return jsonResponse({
      did: this.#accountDid(),
      handle: this.#handle(),
      accessJwt: tokens.access,
      refreshJwt: tokens.refresh,
    });
  }

  async #issueTokens(): Promise<{ access: string; refresh: string }> {
    const cfg = this.#cfg;
    const secret = cfg.jwtSecret as string;
    const nowSec = Math.floor(Date.now() / 1000);
    const base = { sub: this.#accountDid(), iat: nowSec };
    const access = await signJwt(secret, {
      ...base,
      scope: ACCESS_SCOPE,
      exp: nowSec + cfg.accessTokenTtlSeconds,
    });
    const refresh = await signJwt(secret, {
      ...base,
      scope: REFRESH_SCOPE,
      exp: nowSec + cfg.refreshTokenTtlSeconds,
    });
    return { access, refresh };
  }

  async #getSession(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    return jsonResponse({ did: this.#accountDid(), handle: this.#handle() });
  }

  async #refreshSession(request: Request): Promise<Response> {
    await this.#requireAuth(request, REFRESH_SCOPE);
    const tokens = await this.#issueTokens();
    return jsonResponse({
      did: this.#accountDid(),
      handle: this.#handle(),
      accessJwt: tokens.access,
      refreshJwt: tokens.refresh,
    });
  }

  async #requireAuth(request: Request, scope: string): Promise<SessionClaims> {
    const cfg = this.#cfg;
    if (!cfg.jwtSecret) throw authRequired();
    const header = request.headers.get("authorization");
    const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!match) throw authRequired();
    const claims = await verifyJwt(cfg.jwtSecret, match[1] as string);
    if (
      !claims ||
      claims.scope !== scope ||
      claims.sub !== this.#accountDid()
    ) {
      throw authRequired("Invalid or expired token");
    }
    return claims;
  }

  // --- identity -------------------------------------------------------------

  /** The account's current handle: an `updateHandle` override, else config. */
  #handle(): string {
    if (this.#handleCache === null) {
      this.#handleCache =
        (this.#kvGet("handle_override") as string | null) ?? this.#cfg.handle;
    }
    return this.#handleCache;
  }

  /**
   * Change the account handle (`com.atproto.identity.updateHandle`) and announce
   * it on the firehose as an `#identity` event so Relays re-resolve the handle ⇄
   * DID binding. The PDS records the claimed handle; the network still verifies
   * it resolves back to this DID (DNS `_atproto` or `/.well-known/atproto-did`).
   * Serialized through the write chain like every other firehose-emitting change.
   */
  async #updateHandle(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    // The body is untrusted: a non-string `handle` must fail as a clean 400, not
    // throw a TypeError on `.toLowerCase()` (which would surface as a 500).
    const body = (await request.json()) as { handle?: unknown };
    const handle =
      typeof body.handle === "string" ? body.handle.toLowerCase() : undefined;
    if (!handle || !isValidHandle(handle)) {
      throw invalidRequest("`handle` must be a valid handle");
    }
    if (handle !== this.#handle()) {
      this.#kvSet("handle_override", handle);
      this.#handleCache = handle;
      this.#emitIdentity(handle);
    }
    return jsonResponse({});
  }

  #serveDidDocument(): Response {
    const cfg = this.#cfg;
    const multibase = publicKeyMultibase(
      this.#publicKeyRaw(),
      this.#signingCurve(),
    );
    const doc = buildDidDocument({
      did: this.#accountDid(),
      handle: this.#handle(),
      pdsEndpoint: cfg.baseUrl,
      publicKeyMultibase: multibase,
      curve: this.#signingCurve(),
    });
    return jsonResponse(doc as JsonValue);
  }

  #resolveHandle(url: URL): Response {
    const handle = url.searchParams.get("handle");
    if (handle !== this.#handle()) {
      throw namedError(400, "InvalidRequest", "Unable to resolve handle");
    }
    return jsonResponse({ did: this.#accountDid() });
  }

  #describeRepo(): Response {
    const cfg = this.#cfg;
    const collections = this.#sql
      .exec("SELECT DISTINCT collection FROM records ORDER BY collection")
      .toArray()
      .map((row) => row.collection as string);
    return jsonResponse({
      handle: this.#handle(),
      did: this.#accountDid(),
      didDoc: buildDidDocument({
        did: this.#accountDid(),
        handle: this.#handle(),
        pdsEndpoint: cfg.baseUrl,
        publicKeyMultibase: publicKeyMultibase(
          this.#publicKeyRaw(),
          this.#signingCurve(),
        ),
        curve: this.#signingCurve(),
      }) as JsonValue,
      collections,
      handleIsCorrect: true,
    });
  }

  // --- write serialization --------------------------------------------------

  /**
   * Run a commit-chain mutation after every previously enqueued one settles.
   * Durable Objects interleave concurrent requests at `await` points, so without
   * this two writes could each read the same `prev` head and sign forking commits
   * — silently corrupting the linear chain a Relay expects. The chain is a single
   * `Promise` tail; a failed op is isolated (its rejection is swallowed for the
   * chain but still surfaced to its own caller) so one bad write cannot wedge the
   * next. Reads are unaffected; only the four mutating endpoints enqueue here.
   */
  #enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(op);
    this.#writeChain = result.catch(() => undefined);
    return result;
  }

  // --- record writes --------------------------------------------------------

  async #createRecord(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const body = (await request.json()) as {
      collection?: string;
      rkey?: string;
      record?: JsonValue;
    };
    const collection = body.collection;
    if (!collection || !isValidNsid(collection)) {
      throw invalidRequest("`collection` must be a valid NSID");
    }
    if (body.record == null || typeof body.record !== "object") {
      throw invalidRequest("`record` is required");
    }
    const rkey = body.rkey ?? this.#tid.next();
    if (!isValidRecordKey(rkey)) throw invalidRequest("invalid `rkey`");
    if (this.#recordExists(collection, rkey)) {
      throw namedError(400, "InvalidRequest", "Record already exists");
    }
    const { cid, rev } = await this.#writeRecord(
      collection,
      rkey,
      body.record,
      "create",
    );
    return jsonResponse({
      uri: atUri(this.#accountDid(), collection, rkey),
      cid: cid.toString(),
      commit: { cid: this.#kvGet("head_cid"), rev },
    });
  }

  async #putRecord(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const body = (await request.json()) as {
      collection?: string;
      rkey?: string;
      record?: JsonValue;
    };
    const collection = body.collection;
    const rkey = body.rkey;
    if (!collection || !isValidNsid(collection)) {
      throw invalidRequest("`collection` must be a valid NSID");
    }
    if (!rkey || !isValidRecordKey(rkey))
      throw invalidRequest("invalid `rkey`");
    if (body.record == null || typeof body.record !== "object") {
      throw invalidRequest("`record` is required");
    }
    // putRecord upserts: the firehose op is a create or update depending on
    // whether the record already existed.
    const action = this.#recordExists(collection, rkey) ? "update" : "create";
    const { cid, rev } = await this.#writeRecord(
      collection,
      rkey,
      body.record,
      action,
    );
    return jsonResponse({
      uri: atUri(this.#accountDid(), collection, rkey),
      cid: cid.toString(),
      commit: { cid: this.#kvGet("head_cid"), rev },
    });
  }

  async #deleteRecord(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const body = (await request.json()) as {
      collection?: string;
      rkey?: string;
    };
    const { collection, rkey } = body;
    if (!collection || !rkey)
      throw invalidRequest("`collection` and `rkey` are required");
    if (this.#recordExists(collection, rkey)) {
      this.#sql.exec(
        "DELETE FROM records WHERE collection = ? AND rkey = ?",
        collection,
        rkey,
      );
      this.#sql.exec(
        "DELETE FROM record_blobs WHERE collection = ? AND rkey = ?",
        collection,
        rkey,
      );
      const rev = await this.#commit([
        { action: "delete", path: recordPath(collection, rkey), cid: null },
      ]);
      return jsonResponse({ commit: { cid: this.#kvGet("head_cid"), rev } });
    }
    return jsonResponse({});
  }

  /** Encode + store a record, then produce a new signed commit + firehose event. */
  async #writeRecord(
    collection: string,
    rkey: string,
    record: JsonValue,
    action: "create" | "update",
  ): Promise<{ cid: CID; rev: string }> {
    const cborValue = jsonToCbor(record);
    const bytes = encodeCbor(cborValue);
    const cid = await CID.create(DAG_CBOR_CODEC, bytes);
    this.#sql.exec(
      `INSERT INTO records (collection, rkey, cid, value, indexed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (collection, rkey) DO UPDATE SET cid = excluded.cid,
         value = excluded.value, indexed_at = excluded.indexed_at`,
      collection,
      rkey,
      cid.toString(),
      base64(bytes),
      Date.now(),
    );
    this.#indexRecordBlobs(collection, rkey, extractBlobCids(cborValue));
    const rev = await this.#commit([
      { action, path: recordPath(collection, rkey), cid },
    ]);
    return { cid, rev };
  }

  /** Replace the blob-reference index rows for one record. */
  #indexRecordBlobs(
    collection: string,
    rkey: string,
    blobCids: readonly string[],
  ): void {
    this.#sql.exec(
      "DELETE FROM record_blobs WHERE collection = ? AND rkey = ?",
      collection,
      rkey,
    );
    for (const blobCid of new Set(blobCids)) {
      this.#sql.exec(
        "INSERT INTO record_blobs (collection, rkey, blob_cid) VALUES (?, ?, ?)",
        collection,
        rkey,
        blobCid,
      );
    }
  }

  #recordExists(collection: string, rkey: string): boolean {
    return (
      this.#sql
        .exec(
          "SELECT 1 FROM records WHERE collection = ? AND rkey = ? LIMIT 1",
          collection,
          rkey,
        )
        .toArray().length > 0
    );
  }

  // --- record reads ---------------------------------------------------------

  #getRecord(url: URL): Response {
    const collection = url.searchParams.get("collection");
    const rkey = url.searchParams.get("rkey");
    if (!collection || !rkey)
      throw invalidRequest("`collection` and `rkey` are required");
    const row = this.#sql
      .exec(
        "SELECT cid, value FROM records WHERE collection = ? AND rkey = ?",
        collection,
        rkey,
      )
      .toArray()[0];
    if (!row)
      throw namedError(400, "RecordNotFound", "Could not locate record");
    return jsonResponse({
      uri: atUri(this.#accountDid(), collection, rkey),
      cid: row.cid as string,
      value: cborToJson(decodeCbor(unbase64(row.value as string))),
    });
  }

  #listRecords(url: URL): Response {
    const collection = url.searchParams.get("collection");
    if (!collection) throw invalidRequest("`collection` is required");
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1),
      100,
    );
    // Normalise an empty `cursor` param to null (treat it as "no cursor"):
    // otherwise reverse paging would filter on `rkey < ''` and return nothing.
    const cursor = url.searchParams.get("cursor") || null;
    // `reverse=true` lists in descending rkey order; the cursor then pages
    // *down* (rkey < cursor) instead of up. The comparator/order tokens come
    // from a fixed two-value set, never from user input, so interpolating them
    // into the SQL is safe.
    const reverse = url.searchParams.get("reverse") === "true";
    const comparator = reverse ? "<" : ">";
    const order = reverse ? "DESC" : "ASC";
    const rows = this.#sql
      .exec(
        `SELECT rkey, cid, value FROM records
           WHERE collection = ? AND (? IS NULL OR rkey ${comparator} ?)
           ORDER BY rkey ${order} LIMIT ?`,
        collection,
        cursor,
        cursor,
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const records = page.map((row) => ({
      uri: atUri(this.#accountDid(), collection, row.rkey as string),
      cid: row.cid as string,
      value: cborToJson(decodeCbor(unbase64(row.value as string))),
    }));
    const body: { records: JsonValue; cursor?: string } = { records };
    if (rows.length > limit) {
      body.cursor = page[page.length - 1]?.rkey as string;
    }
    return jsonResponse(body);
  }

  // --- blobs ----------------------------------------------------------------

  async #uploadBlob(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    // Reject an oversized upload by its declared length *before* buffering it,
    // so a hostile Content-Length cannot push the DO past its 128 MB ceiling.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#cfg.maxBlobSizeBytes) {
      throw namedError(400, "BlobTooLarge", "Blob exceeds the size limit");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > this.#cfg.maxBlobSizeBytes) {
      throw namedError(400, "BlobTooLarge", "Blob exceeds the size limit");
    }
    const cid = await CID.create(RAW_CODEC, bytes);
    const mime =
      request.headers.get("content-type") ?? "application/octet-stream";
    await this.env.BLOBS.put(this.#blobKey(cid), bytes as BufferSource, {
      httpMetadata: { contentType: mime },
    });
    this.#sql.exec(
      `INSERT INTO blobs (cid, mime, size, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (cid) DO NOTHING`,
      cid.toString(),
      mime,
      bytes.length,
      Date.now(),
    );
    return jsonResponse({
      blob: {
        $type: "blob",
        ref: { $link: cid.toString() },
        mimeType: mime,
        size: bytes.length,
      },
    });
  }

  async #getBlob(url: URL): Promise<Response> {
    const cidParam = url.searchParams.get("cid");
    if (!cidParam) throw invalidRequest("`cid` is required");
    const cid = CID.parse(cidParam);
    const object = await this.env.BLOBS.get(this.#blobKey(cid));
    if (!object) throw namedError(404, "BlobNotFound", "Blob not found");
    const stored =
      object.httpMetadata?.contentType ?? "application/octet-stream";
    const baseType = stored.split(";")[0]?.trim().toLowerCase() ?? "";
    // Blobs are public and served from the account's own origin; the upload's
    // content type is client-controlled. Never sniff, and only serve known
    // media types inline — force anything else to download as an opaque blob so
    // an uploaded `text/html`/SVG cannot execute as script on this origin.
    const inline = SAFE_INLINE_BLOB_TYPES.has(baseType);
    const headers: Record<string, string> = {
      "content-type": inline ? stored : "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    if (!inline) headers["content-disposition"] = "attachment";
    return new Response(object.body, { headers });
  }

  #blobKey(cid: CID): string {
    return `blob/${this.#accountDid()}/${cid.toString()}`;
  }

  /** List the CIDs of blobs this account holds (`com.atproto.sync.listBlobs`). */
  #listBlobs(url: URL): Response {
    const did = url.searchParams.get("did");
    if (!did) throw invalidRequest("`did` is required");
    if (did !== this.#accountDid()) {
      throw namedError(404, "RepoNotFound", "Repo not hosted on this server");
    }
    const limit = clampLimit(url.searchParams.get("limit"), 500, 1000);
    const cursor = url.searchParams.get("cursor");
    // Fetch limit+1 to detect whether a further page exists; cursor is the last
    // CID returned (the blobs table is ordered by CID).
    const rows = (
      cursor
        ? this.#sql.exec(
            "SELECT cid FROM blobs WHERE cid > ? ORDER BY cid LIMIT ?",
            cursor,
            limit + 1,
          )
        : this.#sql.exec(
            "SELECT cid FROM blobs ORDER BY cid LIMIT ?",
            limit + 1,
          )
    )
      .toArray()
      .map((row) => row.cid as string);
    const cids = rows.slice(0, limit);
    const next = rows.length > limit ? cids[cids.length - 1] : undefined;
    return jsonResponse({ cids, ...(next ? { cursor: next } : {}) });
  }

  /** The set of blob CIDs referenced by the current record set (indexed). */
  #referencedBlobCids(): Set<string> {
    return new Set(
      this.#sql
        .exec("SELECT DISTINCT blob_cid FROM record_blobs")
        .toArray()
        .map((row) => row.blob_cid as string),
    );
  }

  /** The held blob CIDs as a set. */
  #heldBlobCids(): Set<string> {
    return new Set(
      this.#sql
        .exec("SELECT cid FROM blobs")
        .toArray()
        .map((row) => row.cid as string),
    );
  }

  /**
   * Blobs referenced by records but not yet uploaded (`listMissingBlobs`). After
   * a migration import, the migrating client uploads exactly these (via
   * `uploadBlob`) to complete the move; the gap is how it knows it is done.
   */
  async #listMissingBlobs(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const url = new URL(request.url);
    const limit = clampLimit(url.searchParams.get("limit"), 500, 1000);
    const cursor = url.searchParams.get("cursor");
    const held = this.#heldBlobCids();
    const missing = [...this.#referencedBlobCids()]
      .filter((cid) => !held.has(cid))
      .sort();
    const after = cursor ? missing.filter((cid) => cid > cursor) : missing;
    const page = after.slice(0, limit);
    const next = after.length > limit ? page[page.length - 1] : undefined;
    return jsonResponse({
      blobs: page.map((cid) => ({ cid })),
      ...(next ? { cursor: next } : {}),
    });
  }

  // --- migration ------------------------------------------------------------

  /**
   * Import a repository CAR export from a source PDS (`com.atproto.repo.importRepo`).
   *
   * The CAR is verified against the source account's signing key — resolved from
   * its DID document (the directory for `did:plc`, the origin for `did:web`),
   * which still points at the source until cutover — then its record set replaces
   * ours and a fresh head commit is signed with *our* key, chaining `prev` to the
   * imported head (the agreed "re-sign on top" model). The current-state store
   * keeps the imported records, not the source's deeper commit history.
   */
  async #importRepo(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const did = this.#accountDid();
    const verifyKey = await resolveSigningKey(did, {
      plcDirectoryUrl: this.#cfg.plcDirectoryUrl,
    });
    const carBytes = new Uint8Array(await request.arrayBuffer());
    const imported = await importRepoFromCar(carBytes, { verifyKey });
    if (imported.did !== did) {
      throw invalidRequest(
        `importRepo: CAR is for ${imported.did}, not this account (${did})`,
      );
    }

    // Replace the record set with the imported records, stored verbatim so their
    // CIDs are preserved, then re-sign a fresh head over them. The clear + inserts
    // run in one transaction so the record set is never left half-replaced (and to
    // avoid a per-statement fsync).
    // Pre-decode blob references per record outside the transaction (CPU work,
    // no storage), then write records + the blob-ref index together.
    const withBlobs = imported.records.map((record) => ({
      record,
      blobCids: extractBlobCids(decodeCbor(record.bytes)),
    }));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec("DELETE FROM records");
      this.#sql.exec("DELETE FROM record_blobs");
      for (const { record, blobCids } of withBlobs) {
        this.#sql.exec(
          `INSERT INTO records (collection, rkey, cid, value, indexed_at)
           VALUES (?, ?, ?, ?, ?)`,
          record.collection,
          record.rkey,
          record.cid.toString(),
          base64(record.bytes),
          now,
        );
        for (const blobCid of new Set(blobCids)) {
          this.#sql.exec(
            "INSERT INTO record_blobs (collection, rkey, blob_cid) VALUES (?, ?, ?)",
            record.collection,
            record.rkey,
            blobCid,
          );
        }
      }
      // Chain the next commit's `prev` to the imported head — atomic with the
      // record replacement.
      this.#kvSet("head_cid", imported.head.toString());
      this.#kvSet("head_rev", imported.rev);
    });
    // Announce the migrated repository on the firehose so Relays pick it up: one
    // `#commit` whose ops are the imported records (each a create).
    const ops: FirehoseRepoOp[] = imported.records.map((record) => ({
      action: "create",
      path: recordPath(record.collection, record.rkey),
      cid: record.cid,
    }));
    const rev = await this.#commit(ops);
    return jsonResponse({
      did,
      head: this.#kvGet("head_cid"),
      rev,
      importedRecords: imported.records.length,
    });
  }

  // --- commit + sync --------------------------------------------------------

  /** Read all records into MST entries (sorted by the recordPath key). */
  #entries(): { entries: MstEntry[]; blocks: CarBlock[] } {
    const rows = this.#sql
      .exec("SELECT collection, rkey, cid, value FROM records")
      .toArray();
    const entries: MstEntry[] = [];
    const blocks: CarBlock[] = [];
    for (const row of rows) {
      const cid = CID.parse(row.cid as string);
      entries.push({
        key: recordPath(row.collection as string, row.rkey as string),
        value: cid,
      });
      blocks.push({ cid, bytes: unbase64(row.value as string) });
    }
    return { entries, blocks };
  }

  /**
   * Read all records into MST entries without decoding any record body — used
   * by {@link #getRepo}, which streams record blocks separately (see
   * {@link repoRecordBlocks}) instead of buffering every decoded body up
   * front the way {@link #entries} does for the commit path.
   */
  #mstEntries(): MstEntry[] {
    return this.#sql
      .exec("SELECT collection, rkey, cid FROM records")
      .toArray()
      .map((row) => ({
        key: recordPath(row.collection as string, row.rkey as string),
        value: CID.parse(row.cid as string),
      }));
  }

  /**
   * Build the MST, sign a new commit chaining to the prior head, and store it.
   * When `ops` is given (a record write/delete or a migration import), a
   * `#commit` event is appended to the firehose and broadcast to subscribers;
   * the empty genesis commit passes none, so it does not appear on the stream.
   */
  async #commit(ops?: readonly FirehoseRepoOp[]): Promise<string> {
    const { entries, blocks: recordBlocks } = this.#entries();
    const { root, blocks: nodeBlocks } = await buildMst(entries);
    const rev = this.#tid.next();
    const prevCid = this.#kvGet("head_cid");
    const prev = prevCid ? CID.parse(prevCid) : null;
    // The previous head's revision is this event's `since` — captured before the
    // new head overwrites it.
    const since = this.#kvGet("head_rev");
    const sign = await this.#signer();
    const { cid, bytes } = await formatCommit(
      { did: this.#accountDid(), version: 3, data: root, rev, prev },
      sign,
    );
    this.#kvSet("head_cid", cid.toString());
    this.#kvSet("head_rev", rev);
    this.#kvSet("head_bytes", base64(bytes));
    if (ops && ops.length > 0) {
      this.#emitCommit({
        commitCid: cid,
        commitBytes: bytes,
        rev,
        since,
        ops,
        nodeBlocks,
        recordBlocks,
      });
    }
    return rev;
  }

  // --- firehose (com.atproto.sync.subscribeRepos) ---------------------------

  /** The next monotonic, persisted firehose sequence number. */
  #nextSeq(): number {
    const next = Number(this.#kvGet("firehose_seq") ?? "0") + 1;
    this.#kvSet("firehose_seq", String(next));
    return next;
  }

  /**
   * Append a `#commit` event to the firehose: assemble the diff CAR (the signed
   * commit block, the rebuilt MST node blocks, and the blocks of the records
   * this commit created/updated), frame it, persist it for backfill, trim the
   * retention window, and broadcast it to every connected subscriber. Following
   * the package's "rebuild the whole MST each commit" stance, all node blocks are
   * included rather than computing a minimal proof set; the CAR still lets a
   * consumer apply the commit without a full `getRepo`.
   */
  #emitCommit(args: {
    commitCid: CID;
    commitBytes: Uint8Array;
    rev: string;
    since: string | null;
    ops: readonly FirehoseRepoOp[];
    nodeBlocks: Map<string, Uint8Array>;
    recordBlocks: readonly CarBlock[];
  }): void {
    const seq = this.#nextSeq();
    const recordByCid = new Map(
      args.recordBlocks.map((block) => [block.cid.toString(), block.bytes]),
    );
    const carBlocks: CarBlock[] = [
      { cid: args.commitCid, bytes: args.commitBytes },
    ];
    for (const [cidStr, bytes] of args.nodeBlocks) {
      carBlocks.push({ cid: CID.parse(cidStr), bytes });
    }
    for (const op of args.ops) {
      if (!op.cid) continue;
      const bytes = recordByCid.get(op.cid.toString());
      if (bytes) carBlocks.push({ cid: op.cid, bytes });
    }
    const fullCar = writeCar([args.commitCid], carBlocks);
    // The package rebuilds the whole MST into each frame, so a large repo's
    // every-commit diff can outgrow the WebSocket message ceiling. Past the
    // configured cap, send `tooBig`: an empty blocks CAR and no ops/blobs, which
    // tells the consumer to fall back to `getRepo`.
    const tooBig = fullCar.length > this.#cfg.firehoseMaxBlocksBytes;
    // Blobs newly referenced by this commit's created/updated records, so a
    // consumer knows which blobs to fetch without decoding every record itself.
    // Skipped when `tooBig` (the field is emitted empty anyway), so the CBOR
    // decode + extraction isn't wasted on a fall-back-to-getRepo frame.
    const blobCids = new Set<string>();
    if (!tooBig) {
      for (const op of args.ops) {
        if (!op.cid) continue;
        const bytes = recordByCid.get(op.cid.toString());
        if (!bytes) continue;
        for (const blob of extractBlobCids(decodeCbor(bytes))) {
          blobCids.add(blob);
        }
      }
    }
    const frame = encodeCommitFrame({
      seq,
      repo: this.#accountDid(),
      commit: args.commitCid,
      rev: args.rev,
      since: args.since,
      blocks: tooBig ? writeCar([args.commitCid], []) : fullCar,
      ops: tooBig ? [] : args.ops,
      blobs: tooBig ? [] : [...blobCids].map((cid) => CID.parse(cid)),
      tooBig,
      time: new Date().toISOString(),
    });
    this.#appendFrame(seq, frame);
  }

  /**
   * Emit an `#account` event when the migration cutover toggles hosting status.
   * Relays subscribed to the firehose learn the live home changed without
   * re-polling `getRepoStatus`. Shares the single `seq` space and backfill ring
   * with `#commit`, so a reconnecting consumer replays it like any other event.
   */
  #emitAccount(active: boolean): void {
    const seq = this.#nextSeq();
    const frame = encodeAccountFrame({
      seq,
      did: this.#accountDid(),
      time: new Date().toISOString(),
      active,
      // The only inactive state this PDS produces is an owner deactivation.
      ...(active ? {} : { status: "deactivated" }),
    });
    this.#appendFrame(seq, frame);
  }

  /**
   * Emit an `#identity` event when the account handle changes (`updateHandle`).
   * Shares the single `seq` space and backfill ring with `#commit`/`#account`.
   */
  #emitIdentity(handle: string): void {
    const seq = this.#nextSeq();
    const frame = encodeIdentityFrame({
      seq,
      did: this.#accountDid(),
      time: new Date().toISOString(),
      handle,
    });
    this.#appendFrame(seq, frame);
  }

  /** Persist a framed event to the backfill ring (trimming it) and broadcast. */
  #appendFrame(seq: number, frame: Uint8Array): void {
    this.#sql.exec(
      "INSERT INTO firehose (seq, frame) VALUES (?, ?)",
      seq,
      base64(frame),
    );
    this.#sql.exec(
      "DELETE FROM firehose WHERE seq <= ?",
      seq - FIREHOSE_RETENTION,
    );
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // A socket gone mid-broadcast is harmless: the consumer reconnects with
        // `?cursor=` and replays the gap from the buffer.
      }
    }
  }

  /**
   * Open a firehose subscription (`com.atproto.sync.subscribeRepos`). The socket
   * is accepted for **hibernation** so it survives the DO evicting from memory;
   * an optional `?cursor=` replays buffered events before the live stream. The
   * replay is synchronous, so no concurrent commit can interleave between it and
   * going live.
   */
  #subscribeRepos(request: Request, url: URL): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw invalidRequest("subscribeRepos requires a WebSocket upgrade");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) this.#backfill(server, cursor);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Replay buffered frames after `cursor`, signalling future/outdated cursors. */
  #backfill(ws: WebSocket, cursorParam: string): void {
    // A cursor is a non-negative integer seq. Validate strictly:
    // `Number.parseInt` would silently accept "1abc"/"1.5", and a negative value
    // would match every buffered row. A terminal error closes the socket.
    if (!/^\d+$/.test(cursorParam)) {
      ws.send(
        encodeErrorFrame(
          "InvalidRequest",
          "cursor must be a non-negative integer",
        ),
      );
      this.#closeAfterError(ws, "Invalid cursor");
      return;
    }
    const cursor = Number.parseInt(cursorParam, 10);
    const head = Number(this.#kvGet("firehose_seq") ?? "0");
    if (cursor > head) {
      ws.send(
        encodeErrorFrame("FutureCursor", "cursor is ahead of the stream"),
      );
      this.#closeAfterError(ws, "Future cursor");
      return;
    }
    const oldest = (
      this.#sql.exec("SELECT MIN(seq) AS seq FROM firehose").toArray()[0] as {
        seq: number | null;
      }
    ).seq;
    if (oldest !== null && cursor < oldest - 1) {
      ws.send(
        encodeInfoFrame(
          "OutdatedCursor",
          "requested cursor predates the backfill window",
        ),
      );
    }
    // The replay is intentionally synchronous (no `await`) so JS run-to-
    // completion semantics guarantee no concurrent `#commit` can interleave
    // and broadcast a newer frame to this socket before the backfill catches
    // up (see the class doc comment) — so this loop cannot `await` a real
    // drain signal without reintroducing that race, and Workers' WebSocket
    // exposes no `bufferedAmount` to poll synchronously either way. Instead,
    // a cumulative byte budget bounds the worst case: once it's exceeded, the
    // replay refuses to queue more and closes the connection rather than
    // handing an unbounded burst to a slow client. The cursor is iterated
    // directly (not `.toArray()`'d) so the budget check gates further reads
    // from SQLite, not just further sends to the socket — `.toArray()` would
    // materialize every matching row up front regardless of the budget,
    // still risking the DO's 128 MB memory ceiling on a large backfill
    // window even though the socket itself would never see more than
    // MAX_BACKFILL_BYTES.
    let sentBytes = 0;
    for (const row of this.#sql.exec(
      "SELECT frame FROM firehose WHERE seq > ? ORDER BY seq",
      cursor,
    )) {
      const frame = unbase64(row.frame as string);
      sentBytes += frame.byteLength;
      if (sentBytes > MAX_BACKFILL_BYTES) {
        ws.send(
          encodeErrorFrame(
            "BackfillOverflow",
            "backfill exceeds the per-connection byte budget; reconnect with a more recent cursor",
          ),
        );
        this.#closeAfterError(ws, "Backfill budget exceeded");
        return;
      }
      ws.send(frame);
    }
  }

  /**
   * Close a subscription after a terminal error frame, using an application
   * close code (4000) so the client can tell a rejected cursor from a normal
   * close. The buffered error frame flushes before the close.
   */
  #closeAfterError(ws: WebSocket, reason: string): void {
    try {
      ws.close(4000, reason);
    } catch {
      // Closing an already-closing socket throws; nothing left to do.
    }
  }

  override async webSocketMessage(): Promise<void> {
    // The repo firehose is server-to-client only; inbound frames are ignored.
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // Compat dates before 2026-04-07 don't auto-complete the close handshake;
    // omitting this leaves the peer with a 1006 abnormal closure. Safe to call
    // unconditionally once auto-reply is on (a no-op) or ahead of it (already
    // wrapped for the closing-socket-throws case below).
    try {
      ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, reason);
    } catch {
      // Closing an already-closing socket throws; nothing left to do.
    }
  }

  async #getRepo(): Promise<Response> {
    const headCid = this.#kvGet("head_cid");
    const headBytes = this.#kvGet("head_bytes");
    if (!headCid || !headBytes)
      throw namedError(404, "RepoNotFound", "Empty repo");
    const { blocks: nodeBlocks } = await buildMst(this.#mstEntries());
    const cid = CID.parse(headCid);
    const bytes = unbase64(headBytes);
    // Stream the CAR out rather than materializing it in memory: every
    // Relay/AppView doing a full sync calls this, and it's the `tooBig`
    // firehose fallback, so a large repository must not have to fit in the
    // DO's 128 MB. `repoBlocks` decodes one record body at a time as the
    // stream is pulled.
    const body = writeCarStream(
      [cid],
      repoBlocks(cid, bytes, nodeBlocks, this.#sql),
    );
    return new Response(body, {
      headers: { "content-type": CAR_CONTENT_TYPE },
    });
  }

  #getLatestCommit(): Response {
    const cid = this.#kvGet("head_cid");
    const rev = this.#kvGet("head_rev");
    if (!cid || !rev) throw namedError(404, "RepoNotFound", "Empty repo");
    return jsonResponse({ cid, rev });
  }

  // --- kv helpers -----------------------------------------------------------

  #kvGet(key: string): string | null {
    const row = this.#sql
      .exec("SELECT v FROM kv WHERE k = ?", key)
      .toArray()[0];
    return row ? (row.v as string) : null;
  }

  #kvSet(key: string, value: string): void {
    this.#sql.exec(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      key,
      value,
    );
  }
}
