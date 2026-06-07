/**
 * Test-only Worker entrypoint: exports the {@link RemoteStorageObject} Durable
 * Object class so the vitest pool can bind it, and a default `fetch` that mounts
 * the remoteStorage handler. Excluded from the published build; not part of the
 * package's public surface.
 */

import { createRemoteStorage } from "./handler";
import type { RemoteStorageEnv } from "./config";

export { RemoteStorageObject } from "./storage";

export default {
  fetch(): Response {
    // The integration tests call `createRemoteStorage` directly with the test
    // bindings; this default exists only so the Worker module is valid.
    void createRemoteStorage;
    return new Response("ok");
  },
} satisfies ExportedHandler<RemoteStorageEnv>;
