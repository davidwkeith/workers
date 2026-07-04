/**
 * Test-only Worker entrypoint: re-exports the Durable Object classes so the
 * vitest pool can bind them, plus the composed Worker as default. Excluded
 * from the build; not part of the public surface.
 */

import worker from "./index.js";

export {
  ActivityPubObject,
  AtprotoRepoObject,
  RemoteStorageObject,
  SolidPodObject,
  WebAuthnObject,
} from "./index.js";

export default worker;
