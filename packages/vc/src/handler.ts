/**
 * The `@dwk/vc` fetch handler: VC-API-style issuance and verification endpoints,
 * a status-update endpoint, and the served (signed) Bitstring Status List
 * credentials. Routing matches the request pathname against each configured
 * endpoint's path, so the handler is mountable under any prefix simply by
 * configuring absolute endpoint URLs.
 *
 * The DID document itself is a static artifact ({@link ./did-web.buildDidDocument});
 * this handler covers only the dynamic parts: signing credentials with the
 * domain's key (a secret binding), verifying them, and flipping status bits in a
 * strongly-consistent D1 store.
 */

import { hostFromUrl, type LogFields } from "@dwk/log";

import {
  resolveConfig,
  type ResolvedVcConfig,
  type VcConfig,
} from "./config.js";
import {
  addProof,
  importSigner,
  verifyProof,
  type JsonObject,
  type Signer,
  type VerificationMethodResolver,
} from "./data-integrity.js";
import { createDidWebResolver } from "./did-web.js";
import { checkValidityPeriod, validateCredential } from "./credential.js";
import { VcLogEvent } from "./log.js";
import {
  buildEncodedList,
  buildStatusEntry,
  buildStatusListCredential,
  createVcStatusStore,
  decodeBitstring,
  findStatusEntry,
  getBit,
  statusEntryIndex,
  type StatusPurpose,
  type VcStatusStore,
  type VcStatusStoreEnv,
} from "./status-list.js";

/** Cloudflare bindings required by the `@dwk/vc` handler. */
export interface VcEnv extends Partial<VcStatusStoreEnv> {
  /**
   * The issuer's **private** signing key as a JWK JSON string (secret binding).
   * Its public half is published in the DID document's verification method.
   */
  readonly VC_SIGNING_KEY: string;
}

/** A `fetch`-compatible Worker handler. */
export type VcHandler = (
  request: Request,
  env: VcEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function problem(
  reason: string,
  description: string,
  status: number,
): Response {
  return json({ error: reason, error_description: description }, status);
}

function emit(
  config: ResolvedVcConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

// Importing a key with crypto.subtle is comparatively expensive, and the secret
// binding is stable for the life of the isolate. Cache the resolved Signer by the
// raw JWK string so a hot issuance path imports the key once, not per request.
const signerCache = new Map<string, Signer>();

/** Parse and validate the signing-key secret binding (fail loudly). */
async function loadSigner(env: VcEnv): Promise<Signer> {
  if (!env.VC_SIGNING_KEY || typeof env.VC_SIGNING_KEY !== "string") {
    throw new Error(
      "@dwk/vc: missing required secret binding `VC_SIGNING_KEY`",
    );
  }
  const cached = signerCache.get(env.VC_SIGNING_KEY);
  if (cached !== undefined) return cached;

  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(env.VC_SIGNING_KEY) as JsonWebKey;
  } catch {
    throw new Error("@dwk/vc: `VC_SIGNING_KEY` is not valid JWK JSON");
  }
  const signer = await importSigner(jwk);
  signerCache.set(env.VC_SIGNING_KEY, signer);
  return signer;
}

function getStore(env: VcEnv): VcStatusStore | undefined {
  return env.VC_STATUS_DB
    ? createVcStatusStore({ VC_STATUS_DB: env.VC_STATUS_DB })
    : undefined;
}

/** The status list credential URL for a purpose, under this issuer. */
function statusListUrl(
  config: ResolvedVcConfig,
  purpose: StatusPurpose,
): string {
  return `${config.statusListEndpoint}/${purpose}`;
}

async function isObjectBody(request: Request): Promise<JsonObject | null> {
  try {
    const body = (await request.json()) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return body as JsonObject;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** POST issue: sign a credential, optionally attaching a status entry. */
async function handleIssue(
  request: Request,
  env: VcEnv,
  config: ResolvedVcConfig,
): Promise<Response> {
  if (!(await config.authorize("issue", request))) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "unauthorized" });
    return problem("unauthorized", "not authorized to issue credentials", 401);
  }
  const body = await isObjectBody(request);
  const credential = body?.credential;
  if (
    credential === null ||
    typeof credential !== "object" ||
    Array.isArray(credential)
  ) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "malformed_request" });
    return problem("malformed_request", "body must be { credential }", 400);
  }
  const doc = credential as JsonObject;

  const errors = validateCredential(doc);
  if (errors.length > 0) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "malformed_request" });
    return problem("malformed_request", errors.join("; "), 400);
  }

  // Attach a status entry when status is enabled, the request does not opt out,
  // and the credential does not already carry one.
  if (
    config.statusEnabled &&
    body?.credentialStatus !== false &&
    doc.credentialStatus === undefined
  ) {
    const store = getStore(env);
    if (store !== undefined) {
      await store.init();
      const listUrl = statusListUrl(config, config.statusPurpose);
      const index = await store.allocateIndex(listUrl, config.statusPurpose);
      doc.credentialStatus = buildStatusEntry({
        statusListCredential: listUrl,
        statusListIndex: index,
        statusPurpose: config.statusPurpose,
      });
    }
  }

  let signer: Signer;
  try {
    signer = await loadSigner(env);
  } catch (error) {
    return problem("server_error", (error as Error).message, 500);
  }

  const verifiableCredential = await addProof(doc, signer, {
    verificationMethod: config.verificationMethod,
  });
  emit(config, "info", VcLogEvent.Issued, { cryptosuite: signer.cryptosuite });
  return json({ verifiableCredential });
}

/** Resolve a credential's status bit, best-effort. */
async function checkStatus(
  credential: JsonObject,
  env: VcEnv,
  config: ResolvedVcConfig,
): Promise<{ checked: boolean; revoked: boolean; error?: string }> {
  const entry = findStatusEntry(credential, config.statusPurpose);
  if (entry === undefined) return { checked: false, revoked: false };
  const index = statusEntryIndex(entry);
  const listCredential = entry.statusListCredential;
  if (index === undefined || typeof listCredential !== "string") {
    return {
      checked: false,
      revoked: false,
      error: "malformed credentialStatus",
    };
  }

  // Our own list: read the authoritative D1 store directly.
  const store = getStore(env);
  if (
    store !== undefined &&
    listCredential.startsWith(config.statusListEndpoint)
  ) {
    const revoked = await store.getStatus(
      listCredential,
      config.statusPurpose,
      index,
    );
    return { checked: true, revoked };
  }

  // Foreign list: fetch the published status list credential and decode it.
  // Only https: is fetched — a foreign `statusListCredential` is attacker-
  // controlled, so refusing other schemes blunts SSRF into internal services.
  let listUrl: URL;
  try {
    listUrl = new URL(listCredential);
  } catch {
    return { checked: false, revoked: false, error: "status list malformed" };
  }
  if (listUrl.protocol !== "https:") {
    return {
      checked: false,
      revoked: false,
      error: "status list URL must use https",
    };
  }
  try {
    const response = await fetch(listUrl.toString(), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        checked: false,
        revoked: false,
        error: "status list unreachable",
      };
    }
    const listCred = (await response.json()) as JsonObject;
    const subject = listCred.credentialSubject as JsonObject | undefined;
    const encodedList = subject?.encodedList;
    if (typeof encodedList !== "string") {
      return { checked: false, revoked: false, error: "status list malformed" };
    }
    const bits = await decodeBitstring(encodedList);
    return { checked: true, revoked: getBit(bits, index) };
  } catch {
    return { checked: false, revoked: false, error: "status list unreachable" };
  }
}

/** POST verify: structural + validity + proof + status checks. */
async function handleVerify(
  request: Request,
  env: VcEnv,
  config: ResolvedVcConfig,
  resolver: VerificationMethodResolver,
): Promise<Response> {
  const body = await isObjectBody(request);
  const vc = body?.verifiableCredential ?? body?.credential;
  if (vc === null || typeof vc !== "object" || Array.isArray(vc)) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "malformed_request" });
    return problem(
      "malformed_request",
      "body must be { verifiableCredential }",
      400,
    );
  }
  const doc = vc as JsonObject;

  const errors: string[] = [...validateCredential(doc)];
  const warnings: string[] = [];

  const proofResult = await verifyProof(doc, {
    resolveVerificationMethod: resolver,
  });
  errors.push(...proofResult.errors);

  const validity = checkValidityPeriod(doc);
  if (validity !== null) errors.push(`credential is ${validity}`);

  const status = await checkStatus(doc, env, config);
  if (status.error !== undefined) warnings.push(status.error);
  if (status.checked && status.revoked) {
    errors.push(
      config.statusPurpose === "revocation"
        ? "credential is revoked"
        : `credential status "${config.statusPurpose}" is set`,
    );
  }

  const verified = errors.length === 0;
  emit(config, verified ? "info" : "warn", VcLogEvent.Verified, { verified });
  return json({ verified, errors, warnings });
}

/** POST status: flip a credential's status bit (e.g. revoke). */
async function handleStatusUpdate(
  request: Request,
  env: VcEnv,
  config: ResolvedVcConfig,
): Promise<Response> {
  if (!config.statusEnabled) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "status_disabled" });
    return problem("status_disabled", "status lists are not enabled", 404);
  }
  if (!(await config.authorize("status", request))) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "unauthorized" });
    return problem("unauthorized", "not authorized to change status", 401);
  }
  const store = getStore(env);
  if (store === undefined) {
    return problem("server_error", "missing D1 binding `VC_STATUS_DB`", 500);
  }

  const body = await isObjectBody(request);
  if (body === null) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "malformed_request" });
    return problem("malformed_request", "body must be a JSON object", 400);
  }

  // Accept either a full credential (read its status entry) or an explicit index.
  let index: number | undefined;
  const purpose = (
    typeof body.statusPurpose === "string"
      ? body.statusPurpose
      : config.statusPurpose
  ) as StatusPurpose;
  const cred = body.credential;
  if (cred !== undefined && typeof cred === "object" && !Array.isArray(cred)) {
    const entry = findStatusEntry(cred as JsonObject, purpose);
    if (entry !== undefined) index = statusEntryIndex(entry);
  }
  if (index === undefined) {
    const raw = body.statusListIndex ?? body.index;
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) index = n;
  }
  if (index === undefined) {
    emit(config, "warn", VcLogEvent.Rejected, { reason: "malformed_request" });
    return problem(
      "malformed_request",
      "provide a credential with a status entry or a statusListIndex",
      400,
    );
  }

  const value = body.status === undefined ? true : body.status === true;
  await store.init();
  await store.setStatus(statusListUrl(config, purpose), purpose, index, value);
  emit(config, "info", VcLogEvent.StatusChanged, {
    statusPurpose: purpose,
    value,
  });
  return json({ status: "ok", statusListIndex: index, value });
}

/** GET a signed status list credential for a purpose. */
async function handleStatusList(
  env: VcEnv,
  config: ResolvedVcConfig,
  purposeSegment: string,
): Promise<Response> {
  if (!config.statusEnabled) {
    return problem("status_disabled", "status lists are not enabled", 404);
  }
  const store = getStore(env);
  if (store === undefined) {
    return problem("server_error", "missing D1 binding `VC_STATUS_DB`", 500);
  }
  const purpose = purposeSegment as StatusPurpose;
  const listUrl = statusListUrl(config, purpose);
  await store.init();
  const indices = await store.setIndices(listUrl, purpose);

  const encodedList = await buildEncodedList(indices, config.statusListLength);
  const unsigned = buildStatusListCredential({
    id: listUrl,
    statusPurpose: purpose,
    encodedList,
    issuer: config.did,
  });

  let signer: Signer;
  try {
    signer = await loadSigner(env);
  } catch (error) {
    return problem("server_error", (error as Error).message, 500);
  }
  const signed = await addProof(unsigned, signer, {
    verificationMethod: config.verificationMethod,
  });
  return json(signed);
}

/**
 * Build the `@dwk/vc` handler from configuration.
 *
 * The returned handler routes `POST {issueEndpoint}`, `POST {verifyEndpoint}`,
 * `POST {statusEndpoint}`, and `GET {statusListEndpoint}/<purpose>`. Issuance and
 * status changes are gated by the configured {@link AuthorizeOperation} hook (or
 * the composing Worker's front door) and require the `VC_SIGNING_KEY` secret;
 * status requires the `VC_STATUS_DB` D1 binding. Unmatched routes get `404`;
 * wrong methods get `405`. The issuer credential / `issuerId` is recorded by host
 * only; subjects, claims, keys, and proof values are never logged.
 */
export function createVc(config: VcConfig): VcHandler {
  const resolved = resolveConfig(config);
  // Default verification resolver: did:web over the global fetch.
  const resolver: VerificationMethodResolver =
    resolved.resolveDid ?? createDidWebResolver();

  return async (request, env, _ctx) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === resolved.issuePath) {
      if (method !== "POST") return methodNotAllowed(resolved, "POST");
      return handleIssue(request, env, resolved);
    }
    if (path === resolved.verifyPath) {
      if (method !== "POST") return methodNotAllowed(resolved, "POST");
      return handleVerify(request, env, resolved, resolver);
    }
    if (path === resolved.statusPath) {
      if (method !== "POST") return methodNotAllowed(resolved, "POST");
      return handleStatusUpdate(request, env, resolved);
    }
    if (path.startsWith(`${resolved.statusListPath}/`)) {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(resolved, "GET");
      }
      const segment = path.slice(resolved.statusListPath.length + 1);
      if (segment.length === 0 || segment.includes("/")) {
        return problem("not_found", "no such status list", 404);
      }
      const response = await handleStatusList(env, resolved, segment);
      return method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    }

    emit(resolved, "warn", VcLogEvent.Rejected, {
      reason: "not_found",
      host: hostFromUrl(request.url),
    });
    return problem("not_found", "no such endpoint", 404);
  };
}

function methodNotAllowed(config: ResolvedVcConfig, allow: string): Response {
  emit(config, "warn", VcLogEvent.Rejected, { reason: "method_not_allowed" });
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...JSON_HEADERS, allow },
  });
}
