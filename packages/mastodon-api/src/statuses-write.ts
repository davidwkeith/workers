/**
 * `POST /api/v1/statuses` — owner-authored status creation.
 *
 * This is the opt-in write surface (`config.allowWrites`). It extends the
 * documented plain-bearer DPoP-everywhere exception from read-only to
 * owner-scoped write: the route requires a `write`-scoped bearer for the
 * single owner account, and every other mitigation is unchanged (tokens are
 * opaque, hashed at rest, isolated to this package, RFC 7009 revocable). When
 * writes are not enabled — the default — the route answers `404`, so the
 * exception stays strictly read-only exactly as before.
 *
 * @see spec/packages/mastodon-api.md § Write surface
 */

import { authenticateBearer, tokenHasScope } from "./auth.js";
import { statusEntity } from "./entities.js";
import {
  accountRequired,
  insufficientScope,
  invalidToken,
  recordNotFound,
  unprocessable,
} from "./errors.js";
import type { RouteContext } from "./handler.js";
import { credentialAccountEntity } from "./entities.js";
import { createMastodonStore } from "./store.js";
import type { BackendPublishInput } from "./backend.js";

/** Default Mastodon status character ceiling; clients read it from `Instance`. */
const MAX_STATUS_CHARS = 500;

interface StatusForm {
  readonly status: string;
  readonly spoilerText?: string;
  readonly sensitive?: boolean;
}

async function readStatusForm(request: Request): Promise<StatusForm> {
  let raw: Record<string, unknown> = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON → empty fields; validation reports the 422 below.
    }
  } else {
    try {
      const form = await request.formData();
      for (const [key, value] of form) {
        if (typeof value === "string") raw[key] = value;
      }
    } catch {
      // Malformed body → empty fields, as above.
    }
  }
  const truthy = (value: unknown): boolean =>
    value === true || value === "true" || value === "1";
  return {
    status: typeof raw["status"] === "string" ? raw["status"] : "",
    ...(typeof raw["spoiler_text"] === "string" && raw["spoiler_text"] !== ""
      ? { spoilerText: raw["spoiler_text"] }
      : {}),
    ...(raw["sensitive"] !== undefined
      ? { sensitive: truthy(raw["sensitive"]) }
      : {}),
  };
}

/** `POST /api/v1/statuses`. */
export async function handleCreateStatus(ctx: RouteContext): Promise<Response> {
  // Writes are opt-in and require a backend that can publish. When either is
  // absent the route does not exist — `404`, keeping the read-only default.
  if (!ctx.config.allowWrites || !ctx.config.backend?.publishStatus) {
    return recordNotFound();
  }
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!tokenHasScope(token.scope, "write:statuses")) {
    return insufficientScope();
  }

  const form = await readStatusForm(ctx.request);
  const status = form.status.trim();
  if (status.length === 0) {
    return unprocessable("Validation failed: Text can't be blank");
  }
  if (status.length > MAX_STATUS_CHARS) {
    return unprocessable(
      `Validation failed: Text is too long (maximum is ${MAX_STATUS_CHARS} characters)`,
    );
  }

  const input: BackendPublishInput = {
    status,
    ...(form.spoilerText !== undefined
      ? { spoilerText: form.spoilerText }
      : {}),
    ...(form.sensitive !== undefined ? { sensitive: form.sensitive } : {}),
  };
  const entry = await ctx.config.backend.publishStatus(input);
  const ownerAccount = credentialAccountEntity(
    ctx.config,
    (await ctx.config.backend.account()).counts,
  );
  return Response.json(
    statusEntity(entry, { baseUrl: ctx.config.baseUrl, ownerAccount }),
  );
}
