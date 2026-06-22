/**
 * `@dwk/activitypub` — edge-native ActivityPub actor.
 *
 * A native [ActivityPub](https://www.w3.org/TR/activitypub/) actor rooted at the
 * user's own domain, making the self-owned presence a first-class fediverse
 * citizen (followers, replies, boosts) rather than a bridged guest. It mirrors
 * the architecture proven in `@dwk/solid-pod`: a stateless Worker front door
 * (routing + edge HTTP-signature verification) over a per-actor Durable Object
 * that is the consistency authority for activity-`id` dedup, the
 * follower/following/outbox collections, and the signed outbound delivery queue
 * (retry/backoff via DO alarms). This is the second `@dwk` package to ship a
 * Durable Object.
 *
 * The package is **not** protocol-agnostic: it is the ActivityPub endpoint. v1
 * covers server-to-server federation (inbound `Follow`/`Undo`/`Create`/`Like`/
 * `Announce`/`Delete` with signature verification and dedup; auto-`Accept` of
 * follows; signed fan-out delivery), the actor document and paged
 * `OrderedCollection`s, and NodeInfo discovery. Client-to-server authoring is
 * out of scope — `@dwk/micropub` covers authoring, and the owner publish
 * endpoint (`POST <actor>/outbox`) is the publish → `Create` fan-out seam.
 *
 * HTTP Message Signatures are implemented inline against the de-facto fediverse
 * `draft-cavage` profile so the actor federates today; signing/verification sit
 * behind the {@link ActivityPubConfig.verifyInboxSignature} seam so the
 * forthcoming cross-standard `@dwk/http-signatures` package (issue #59) can be
 * swapped in unchanged.
 *
 * @see spec/packages/activitypub.md
 * @packageDocumentation
 */

export { createActivityPub, type ActivityPubHandler } from "./handler.js";
export { ActivityPubObject } from "./object.js";

export {
  resolveConfig,
  deriveIris,
  type ActivityPubConfig,
  type ActivityPubEnv,
  type ResolvedConfig,
  type InboxVerifier,
} from "./config.js";

export {
  AS2_NS,
  AS2_CONTENT_TYPE,
  AS2_LD_CONTENT_TYPE,
  PUBLIC_AUDIENCE,
  buildActorDocument,
  buildCollection,
  buildCollectionPage,
  wantsActivityJson,
  as2ContentType,
  type ActorProfile,
  type ActorIris,
  type ActorDocumentOptions,
  type ActivityObject,
} from "./as2.js";

export {
  calendarEventToActivityStreams,
  participationTarget,
  type ActivityStreamsEventOptions,
} from "./events.js";

export {
  buildNodeInfoDiscovery,
  buildNodeInfo20,
  buildNodeInfo21,
  type SoftwareInfo,
  type UsageCounts,
} from "./nodeinfo.js";

export {
  signRequest,
  verifyInboxSignature,
  digestHeader,
  importPublicKey,
  importPrivateKey,
  type KeyResolver,
  type ResolvedKey,
  type VerifyResult,
  type VerifyFailureReason,
  type InboxRequest,
  type SignerKey,
} from "./signature.js";

export {
  deliverActivity,
  assertPublicHttpsTarget,
  DeliveryBlockedError,
  type DeliveryResult,
} from "./delivery.js";

export { ActivityPubLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
