/**
 * Test-only Worker entrypoint: exports the {@link SolidPodObject} Durable Object
 * class so the vitest pool can bind it, and a default `fetch` that mounts the
 * Solid Pod handler. Excluded from the published build; not part of the
 * package's public surface.
 */

import { createSolidPod } from "./handler";
import type { SolidPodEnv } from "./config";

export { SolidPodObject } from "./pod";

export default {
  fetch(): Response {
    // The integration tests call `createSolidPod` directly with the test
    // bindings; this default exists only so the Worker module is valid.
    void createSolidPod;
    return new Response("ok");
  },
} satisfies ExportedHandler<SolidPodEnv>;
