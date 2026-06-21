/**
 * `@dwk/ldn` — Linked Data Notifications (W3C LDN) primitives.
 *
 * @remarks
 * Cross-standard reusable library: it implements the three LDN roles —
 * **discovery** (advertise / find an inbox via `ldp:inbox`), **receiver**
 * (validate a posted RDF notification), and **consumer** (read an inbox
 * listing) — as plain-data functions over `@dwk/rdf`'s flat `StoredQuad`
 * representation. It carries no Cloudflare bindings, no transport, and **no
 * Solid/WAC assumptions**, so the same primitives back the `@dwk/solid-pod`
 * inbox and the `@dwk/activitypub` inbox without either leaking into the other.
 * Authorization, dedup, and storage stay the caller's concern.
 *
 * @see {@link https://www.w3.org/TR/ldn/ | W3C Linked Data Notifications}
 * @see spec/packages/ldn.md
 * @packageDocumentation
 */

export {
  LDP_NAMESPACE,
  LDP_INBOX,
  LDP_CONTAINS,
  LDP_CONSTRAINED_BY,
  LDP_CONTAINER,
  LDP_RESOURCE,
  RDF_TYPE,
} from "./vocab.js";

export {
  inboxLinkHeader,
  inboxTriple,
  constrainedByLinkHeader,
  discoverInboxIris,
  parseInboxLinks,
} from "./discovery.js";

export {
  parseNotification,
  acceptedContentTypes,
  acceptPostHeader,
  NotificationProblem,
  type NotificationProblemCode,
  type ParsedNotification,
  type ParseNotificationOptions,
} from "./notification.js";

export { inboxListingQuads, listInboxMembers } from "./listing.js";
