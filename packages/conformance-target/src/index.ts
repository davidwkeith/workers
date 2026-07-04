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

export type { ConformanceEnv } from "./config.js";
export { configsFor, ownerWebId, USERNAME } from "./config.js";

// The five Durable Objects served by this Worker (wrangler.jsonc declares them
// against this module).
export { ActivityPubObject } from "@dwk/activitypub";
export { AtprotoRepoObject } from "@dwk/atproto-pds";
export { RemoteStorageObject } from "@dwk/remotestorage";
export { SolidPodObject } from "@dwk/solid-pod";
export { WebAuthnObject } from "@dwk/webauthn";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<ConformanceEnv>;
