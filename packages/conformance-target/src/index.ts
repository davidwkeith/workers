/**
 * @dwk/conformance-target — every endpoint package composed into one Worker,
 * deployed to conformance.dwk.io as the target for the hosted conformance
 * suites (micropub.rocks, webmention.rocks, Solid harness, litmus). Private,
 * never published; doubles as the reference composition for the monorepo.
 *
 * @see docs/superpowers/specs/2026-07-04-conformance-target-design.md
 * @see spec/composition-contract.md
 */

import { createMicrosubQueueConsumer } from "@dwk/microsub";
import { createSolidPodGc } from "@dwk/solid-pod";
import type { WebmentionJob } from "@dwk/webmention";
import { createWebmentionQueueConsumer } from "@dwk/webmention";
import type { WebSubJob } from "@dwk/websub";
import { createWebSubQueueConsumer } from "@dwk/websub";

import type { ConformanceEnv } from "./config.js";
import { configsFor } from "./config.js";
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

type AnyJob = WebmentionJob | WebSubJob | unknown;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    mounts ??= buildMounts(env);
    return routeRequest(mounts, request, env, ctx);
  },

  async queue(batch, env, ctx): Promise<void> {
    const c = configsFor(env);
    switch (batch.queue) {
      case "conformance-webmention":
        return createWebmentionQueueConsumer(c.webmention)(
          batch as MessageBatch<WebmentionJob>,
          env,
          ctx,
        );
      case "conformance-websub":
        return createWebSubQueueConsumer(c.websub)(
          batch as MessageBatch<WebSubJob>,
          env,
          ctx,
        );
      case "conformance-microsub":
        return createMicrosubQueueConsumer(c.microsub)(
          batch as Parameters<
            ReturnType<typeof createMicrosubQueueConsumer>
          >[0],
          env,
          ctx,
        );
      default:
        throw new Error(
          `@dwk/conformance-target: unknown queue "${batch.queue}"`,
        );
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    // solid-pod and remotestorage share the @dwk/store GC schema and the same
    // BLOBS/GC_DB bindings, so one collector pass covers both packages.
    await createSolidPodGc(configsFor(env).solidPod)(event, env, ctx);
  },
} satisfies ExportedHandler<ConformanceEnv, AnyJob>;
