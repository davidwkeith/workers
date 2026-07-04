/**
 * @dwk/conformance-target — every endpoint package composed into one Worker,
 * deployed to conformance.dwk.io as the target for the hosted conformance
 * suites (micropub.rocks, webmention.rocks, Solid harness, litmus). Private,
 * never published; doubles as the reference composition for the monorepo.
 *
 * @see docs/superpowers/specs/2026-07-04-conformance-target-design.md
 * @see spec/composition-contract.md
 */

import type { ConformanceEnv } from "./config.js";
import type { Mount } from "./mounts.js";
import { buildMounts, routeRequest } from "./mounts.js";

export type { ConformanceEnv } from "./config.js";
export { configsFor, ownerWebId, USERNAME } from "./config.js";

// The five Durable Objects served by this Worker (wrangler.jsonc declares them
// against this module).
export { ActivityPubObject } from "@dwk/activitypub";
export { AtprotoRepoObject } from "@dwk/atproto-pds";
export { RemoteStorageObject } from "@dwk/remotestorage";
export { SolidPodObject } from "@dwk/solid-pod";
export { WebAuthnObject } from "@dwk/webauthn";

let mounts: readonly Mount[] | undefined;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    mounts ??= buildMounts(env);
    return routeRequest(mounts, request, env, ctx);
  },
} satisfies ExportedHandler<ConformanceEnv>;
