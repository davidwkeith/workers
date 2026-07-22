/**
 * `@dwk/micropub` — Micropub create/update/delete endpoint with an R2-backed
 * media endpoint.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix so it composes with other `@dwk` packages in one
 * Worker. It consumes the DPoP-bound IndieAuth access tokens issued by
 * `@dwk/indieauth` — verifying the token signature, completing the DPoP
 * proof-of-possession binding via `@dwk/dpop`, honouring revocation, and gating
 * each action on the token's scope.
 *
 * Published posts are stored as microformats2 source in D1 (a strongly-
 * consistent store — never KV); media blob bodies are streamed to R2. The
 * handler fails loudly at startup if any required binding is missing.
 *
 * @see spec/packages/micropub.md
 * @packageDocumentation
 */

export { createMicropub, absoluteUrl, publishPost } from "./handler.js";
export type {
  MicropubEnv,
  MicropubHandler,
  PublishPostResult,
} from "./handler.js";

export { createMicropubMcpTools } from "./mcp-tools.js";
export type { MicropubMcpToolsConfig } from "./mcp-tools.js";

export { resolveConfig } from "./config.js";
export type {
  MicropubConfig,
  ResolvedConfig,
  SyndicationTarget,
  SyndicationTargetsProvider,
  GeneratePostUrl,
  ExtensionMaturity,
  ExtensionGroupsConfig,
  PostTypeConfig,
  AudienceConfig,
} from "./config.js";

export {
  FEDIVERSE_TARGET_UID,
  entryToFediversePost,
  deliverFediversePost,
  syndicateEntry,
  type FediverseSyndicationConfig,
  type FediversePost,
  type SyndicationResult,
} from "./fediverse.js";

export {
  createMicropubStore,
  recordToMf2,
  type MicropubStore,
  type MicropubStoreEnv,
  type PostRecord,
  type SourceListQuery,
} from "./store.js";

export {
  parseFormBody,
  parseJsonBody,
  parseUpdateOperations,
  applyUpdate,
  sourceView,
  sourceListView,
  validateVocabulary,
  POST_STATUS_VALUES,
  VISIBILITY_VALUES,
  LOCATION_VISIBILITY_VALUES,
  normalizeProposedVocabulary,
  Mf2ParseError,
  type Mf2Object,
  type MicropubCommands,
  type UpdateOperations,
  type ParsedBody,
} from "./mf2.js";

export {
  parsePageRequest,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type PageRequest,
} from "./pagination.js";

export {
  decodeSourceListCursor,
  encodeSourceListCursor,
  hasProposedSourceFilter,
  MAX_SOURCE_FILTER_VALUES,
  parseSourceListFilters,
  sourceFilterFingerprint,
  SourceFilterError,
} from "./source-filters.js";
export type {
  PropertyValueFilter,
  SourceListCursor,
  SourceListFilters,
  SourceListOrder,
} from "./source-filters.js";

export {
  H_EVENT,
  isEvent,
  renderHEvent,
  hEventToCalendarEvent,
} from "./event.js";

export {
  authorize,
  tokenFromHeader,
  hasScope,
  type AuthEnv,
  type AuthResult,
  type AuthSuccess,
  type AuthFailure,
} from "./auth.js";

export { MicropubLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
