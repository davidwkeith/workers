/**
 * `createSolidOidc` — the composition-contract factory. Returns a mountable
 * `(request, env, ctx) => Promise<Response>` routing the OP's four endpoints:
 * discovery, JWKS, authorize, and token.
 *
 * @packageDocumentation
 */

import type { ExecutionContext } from "@cloudflare/workers-types";

import {
  resolveConfig,
  type ResolvedSolidOidcConfig,
  type SolidOidcConfig,
  type SolidOidcEnv,
} from "./config.js";
import { buildDiscoveryDocument, buildJwks } from "./discovery.js";
import { handleAuthorize } from "./authorize.js";
import { json, oauthError } from "./http.js";
import { importSigningKey } from "./jws.js";
import { createCodeStore } from "./store.js";
import { handleToken } from "./token-endpoint.js";

/** The mountable handler shape. */
export type SolidOidcHandler = (
  request: Request,
  env: SolidOidcEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * Build the Solid-OIDC OpenID Provider handler. Fails loudly at first request
 * if the `AUTH_DB` binding is missing (composition contract).
 */
export function createSolidOidc(config: SolidOidcConfig): SolidOidcHandler {
  const resolved: ResolvedSolidOidcConfig = resolveConfig(config);

  return async (request, env) => {
    if (!env.AUTH_DB) {
      throw new Error("@dwk/solid-oidc: required binding AUTH_DB is missing");
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const codes = createCodeStore(env.AUTH_DB);

    // Discovery — GET only, cacheable public document.
    if (path === resolved.paths.discovery) {
      if (method !== "GET" && method !== "HEAD") {
        return oauthError(405, "invalid_request", "method not allowed");
      }
      return json(200, buildDiscoveryDocument(resolved), {
        "cache-control": "public, max-age=3600",
      });
    }

    // JWKS — GET only.
    if (path === resolved.paths.jwks) {
      if (method !== "GET" && method !== "HEAD") {
        return oauthError(405, "invalid_request", "method not allowed");
      }
      const key = await importSigningKey(resolved.signingKey);
      return json(200, buildJwks(key), {
        "cache-control": "public, max-age=3600",
      });
    }

    // Authorization endpoint — GET.
    if (path === resolved.paths.authorization) {
      if (method !== "GET") {
        return oauthError(405, "invalid_request", "method not allowed");
      }
      return handleAuthorize(request, resolved, codes);
    }

    // Token endpoint — POST.
    if (path === resolved.paths.token) {
      if (method !== "POST") {
        return oauthError(405, "invalid_request", "method not allowed");
      }
      return handleToken(request, resolved, codes);
    }

    return oauthError(404, "invalid_request", "not found");
  };
}
