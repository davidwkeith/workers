/**
 * `@dwk/remotestorage` — an Unhosted-style remoteStorage personal data vault.
 *
 * A per-user document vault that "no-backend" web apps read and write over a
 * plain HTTP `GET`/`PUT`/`DELETE` API, scoped by OAuth 2.0 bearer tokens
 * (draft-dejong-remotestorage). It is a *competing* personal-data protocol to
 * Solid — simpler, document-oriented, no RDF — filed for completeness, **not**
 * as a recommendation alongside `@dwk/solid-pod`.
 *
 * Its value here is that it rides on the **same backing store** the Pod uses:
 * `@dwk/store` is a generic `key → { rdf | blob }` pointer map, so remoteStorage
 * documents are just its blob tier, and the only library addition this package
 * required is the generic `list(prefix)` projection (which `@dwk/solid-pod`
 * could use for LDP container enumeration too). This package ships a thin
 * per-account Durable Object that reuses `@dwk/store`; the divergent auth model
 * (plain OAuth bearer + per-module `:r`/`:rw` scopes + a public `/public/` tree,
 * not DPoP/WAC) and folder semantics live entirely here.
 *
 * @see spec/packages/remotestorage.md
 * @packageDocumentation
 */

export { createRemoteStorage, type RemoteStorageHandler } from "./handler.js";
export { createRemoteStorageGc, type RemoteStorageGcHandler } from "./gc.js";
export { RemoteStorageObject } from "./storage.js";

export {
  resolveConfig,
  defaultParsePath,
  type RemoteStorageConfig,
  type RemoteStorageEnv,
  type RemoteStorageGcEnv,
  type ResolvedConfig,
  type ParsedPath,
} from "./config.js";

export {
  authenticate,
  bearerToken,
  type RemoteStorageAuth,
  type AuthResult,
  type AuthFailureReason,
} from "./auth.js";

export {
  parseScopes,
  authorizeScopes,
  moduleForPath,
  isFolderPath,
  isPublicDocument,
  ROOT_MODULE,
  type RemoteStorageScope,
  type ScopeMode,
} from "./scope.js";

export {
  buildFolderModel,
  renderFolderDescription,
  hashSignature,
  FOLDER_DESCRIPTION_TYPE,
  FOLDER_DESCRIPTION_CONTEXT,
  type FolderModel,
  type FolderDocument,
  type FolderSubfolder,
  type FolderDescription,
  type FolderItem,
} from "./folder.js";

export {
  corsHeaders,
  preflightResponse,
  withCors,
  ALLOWED_METHODS,
} from "./cors.js";

export {
  remoteStorageLink,
  REMOTESTORAGE_REL,
  REMOTESTORAGE_VERSION,
  type RemoteStorageLinkConfig,
} from "./discovery.js";

export { RemoteStorageLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
