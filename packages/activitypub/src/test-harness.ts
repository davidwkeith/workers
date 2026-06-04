/**
 * Test-only Worker entrypoint: exports the {@link ActivityPubObject} Durable
 * Object class so the vitest pool can bind it, and a default `fetch` that mounts
 * the ActivityPub handler. Excluded from the published build; not part of the
 * package's public surface.
 */

import { createActivityPub } from "./handler";
import type { ActivityPubEnv } from "./config";

export { ActivityPubObject } from "./object";

export default {
  fetch(): Response {
    // The integration tests call `createActivityPub` directly with the test
    // bindings; this default exists only so the Worker module is valid.
    void createActivityPub;
    return new Response("ok");
  },
} satisfies ExportedHandler<ActivityPubEnv>;
