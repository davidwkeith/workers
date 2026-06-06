/**
 * LDP / RDF vocabulary terms used by Linked Data Notifications.
 *
 * LDN layers a single property — `ldp:inbox` — and the LDP container model onto
 * RDF; these constants are the full IRIs so callers never hard-code a typo'd
 * namespace.
 */

/** The LDP namespace IRI. */
export const LDP_NAMESPACE = "http://www.w3.org/ns/ldp#";

/** `ldp:inbox` — the property a resource uses to advertise its inbox. */
export const LDP_INBOX = `${LDP_NAMESPACE}inbox`;

/** `ldp:contains` — links a container to each of its members. */
export const LDP_CONTAINS = `${LDP_NAMESPACE}contains`;

/** `ldp:constrainedBy` — points at the constraints a resource imposes (LDN §5.1). */
export const LDP_CONSTRAINED_BY = `${LDP_NAMESPACE}constrainedBy`;

/** `ldp:Container` — the type of an inbox (a container of notifications). */
export const LDP_CONTAINER = `${LDP_NAMESPACE}Container`;

/** `ldp:Resource` — the LDP resource type. */
export const LDP_RESOURCE = `${LDP_NAMESPACE}Resource`;

/** `rdf:type` — used to assert the inbox container's type in a listing. */
export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
