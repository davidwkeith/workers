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
import { writeCar, type CarBlock } from "./car.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC, RAW_CODEC } from "./cid.js";
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
import { buildDidDocument } from "./identity.js";
import {
  didPlcFromGenesis,
  signPlcOperation,
  type UnsignedPlcOperation,
} from "./plc.js";
import { buildMst, type MstEntry } from "./mst.js";
import {
  atUri,
  cborToJson,
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

export class AtprotoRepoObject extends DurableObject<AtprotoPdsEnv> {
  readonly #sql: SqlStorage;
  readonly #tid = new TidClock();
  #config: ForwardedConfig | null = null;
  #signerFn: Signer | null = null;
  #initPromise: Promise<void> | null = null;

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
      return await this.#dispatch(xrpc[1] as string, request, url);
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

  /** The authoritative account DID (derived at genesis), falling back to config. */
  #accountDid(): string {
    return (this.#kvGet("account_did") as string | null) ?? this.#cfg.did;
  }

  /** The curve this repository was initialised with (authoritative, persisted). */
  #signingCurve(): SigningCurve {
    return (this.#kvGet("signing_curve") as SigningCurve | null) ?? "p256";
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
    return unbase64(this.#kvGet("pubkey_raw") as string);
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
      case "com.atproto.server.describeServer":
        return jsonResponse({
          did: this.#accountDid(),
          availableUserDomains: [],
        });
      case "com.atproto.identity.resolveHandle":
        return this.#resolveHandle(url);
      case "com.atproto.repo.describeRepo":
        return this.#describeRepo();
      case "com.atproto.repo.createRecord":
        return this.#createRecord(request);
      case "com.atproto.repo.putRecord":
        return this.#putRecord(request);
      case "com.atproto.repo.deleteRecord":
        return this.#deleteRecord(request);
      case "com.atproto.repo.getRecord":
        return this.#getRecord(url);
      case "com.atproto.repo.listRecords":
        return this.#listRecords(url);
      case "com.atproto.repo.uploadBlob":
        return this.#uploadBlob(request);
      case "com.atproto.sync.getRepo":
        return this.#getRepo();
      case "com.atproto.sync.getLatestCommit":
        return this.#getLatestCommit();
      case "com.atproto.sync.getBlob":
        return this.#getBlob(url);
      case "com.atproto.sync.listRepos":
        return jsonResponse({
          repos: [
            {
              did: this.#accountDid(),
              head: this.#kvGet("head_cid"),
              rev: this.#kvGet("head_rev"),
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
      handle: cfg.handle,
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
    return jsonResponse({ did: this.#accountDid(), handle: this.#cfg.handle });
  }

  async #refreshSession(request: Request): Promise<Response> {
    await this.#requireAuth(request, REFRESH_SCOPE);
    const tokens = await this.#issueTokens();
    return jsonResponse({
      did: this.#accountDid(),
      handle: this.#cfg.handle,
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

  #serveDidDocument(): Response {
    const cfg = this.#cfg;
    const multibase = publicKeyMultibase(
      this.#publicKeyRaw(),
      this.#signingCurve(),
    );
    const doc = buildDidDocument({
      did: this.#accountDid(),
      handle: cfg.handle,
      pdsEndpoint: cfg.baseUrl,
      publicKeyMultibase: multibase,
    });
    return jsonResponse(doc as JsonValue);
  }

  #resolveHandle(url: URL): Response {
    const handle = url.searchParams.get("handle");
    if (handle !== this.#cfg.handle) {
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
      handle: cfg.handle,
      did: this.#accountDid(),
      didDoc: buildDidDocument({
        did: this.#accountDid(),
        handle: cfg.handle,
        pdsEndpoint: cfg.baseUrl,
        publicKeyMultibase: publicKeyMultibase(
          this.#publicKeyRaw(),
          this.#signingCurve(),
        ),
      }) as JsonValue,
      collections,
      handleIsCorrect: true,
    });
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
    const { cid, rev } = await this.#writeRecord(collection, rkey, body.record);
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
    const { cid, rev } = await this.#writeRecord(collection, rkey, body.record);
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
      const rev = await this.#commit();
      return jsonResponse({ commit: { cid: this.#kvGet("head_cid"), rev } });
    }
    return jsonResponse({});
  }

  /** Encode + store a record, then produce a new signed commit. */
  async #writeRecord(
    collection: string,
    rkey: string,
    record: JsonValue,
  ): Promise<{ cid: CID; rev: string }> {
    const bytes = encodeCbor(jsonToCbor(record));
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
    const rev = await this.#commit();
    return { cid, rev };
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
    const cursor = url.searchParams.get("cursor");
    const rows = this.#sql
      .exec(
        `SELECT rkey, cid, value FROM records
           WHERE collection = ? AND (? IS NULL OR rkey > ?)
           ORDER BY rkey LIMIT ?`,
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
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
      },
    });
  }

  #blobKey(cid: CID): string {
    return `blob/${this.#accountDid()}/${cid.toString()}`;
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

  /** Build the MST, sign a new commit chaining to the prior head, and store it. */
  async #commit(): Promise<string> {
    const { entries } = this.#entries();
    const { root } = await buildMst(entries);
    const rev = this.#tid.next();
    const prevCid = this.#kvGet("head_cid");
    const prev = prevCid ? CID.parse(prevCid) : null;
    const sign = await this.#signer();
    const { cid, bytes } = await formatCommit(
      { did: this.#accountDid(), version: 3, data: root, rev, prev },
      sign,
    );
    this.#kvSet("head_cid", cid.toString());
    this.#kvSet("head_rev", rev);
    this.#kvSet("head_bytes", base64(bytes));
    return rev;
  }

  async #getRepo(): Promise<Response> {
    const headCid = this.#kvGet("head_cid");
    const headBytes = this.#kvGet("head_bytes");
    if (!headCid || !headBytes)
      throw namedError(404, "RepoNotFound", "Empty repo");
    const { entries, blocks } = this.#entries();
    const { blocks: nodeBlocks } = await buildMst(entries);
    const car: CarBlock[] = [
      { cid: CID.parse(headCid), bytes: unbase64(headBytes) },
    ];
    for (const [cidStr, bytes] of nodeBlocks) {
      car.push({ cid: CID.parse(cidStr), bytes });
    }
    car.push(...blocks);
    const body = writeCar([CID.parse(headCid)], car);
    return new Response(body as BodyInit, {
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
