/**
 * IndieAuth authentication + consent for the conformance identity: a single
 * password (secret binding) guards approval. Task 3 implements the form.
 */

import type { IndieAuthConfig } from "@dwk/indieauth";

import type { ConformanceEnv } from "./config.js";

export function approveAuthorization(
  _env: ConformanceEnv,
): IndieAuthConfig["approveAuthorization"] {
  return async () => new Response("Not Implemented", { status: 501 });
}
