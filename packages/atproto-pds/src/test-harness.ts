/**
 * Test-only Worker entrypoint: exports the {@link AtprotoRepoObject} Durable
 * Object class so the vitest pool can bind it, and a default `fetch` that mounts
 * the PDS handler. Excluded from the published build; not part of the package's
 * public surface.
 */

import { createAtprotoPds } from "./handler";
import type { AtprotoPdsEnv } from "./config";

export { AtprotoRepoObject } from "./object";

export default {
  fetch(): Response {
    // The integration tests call `createAtprotoPds` directly with the test
    // bindings; this default exists only so the Worker module is valid.
    void createAtprotoPds;
    return new Response("ok");
  },
} satisfies ExportedHandler<AtprotoPdsEnv>;
