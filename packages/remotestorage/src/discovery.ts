/**
 * remoteStorage discovery (draft §10): the WebFinger link advertising a user's
 * storage root and the OAuth endpoint a connecting app uses.
 *
 * A no-backend app is given only a user address (`user@host`); it discovers the
 * storage root by querying WebFinger for that account and reading the
 * remoteStorage link. This module builds that link as a plain
 * [`@dwk/webfinger`](../webfinger) `Link` so a deployment can drop it into its
 * existing WebFinger resource record rather than standing up a second endpoint.
 * Pure data — no Workers runtime.
 */

import type { Link } from "@dwk/webfinger";

/** The remoteStorage WebFinger link relation (draft §10). */
export const REMOTESTORAGE_REL =
  "http://tools.ietf.org/id/draft-dejong-remotestorage";

/** The remoteStorage draft version advertised in the link properties. */
export const REMOTESTORAGE_VERSION = "draft-dejong-remotestorage-22";

/** Inputs for {@link remoteStorageLink}. */
export interface RemoteStorageLinkConfig {
  /** The user's storage root URL (the `href` apps GET/PUT/DELETE under). */
  readonly storageRoot: string;
  /** The OAuth authorization endpoint (RFC 6749 §4.2 implicit grant). */
  readonly authEndpoint: string;
}

/**
 * Build the WebFinger remoteStorage `Link` for one account. The `properties`
 * carry the spec version, the OAuth authorization URL, and the capability flags
 * remoteStorage clients read (`Bearer` auth, `Content-Range` support); a `null`
 * property value means "advertised as absent", per RFC 7033.
 */
export function remoteStorageLink(config: RemoteStorageLinkConfig): Link {
  return {
    rel: REMOTESTORAGE_REL,
    href: config.storageRoot,
    properties: {
      "http://remotestorage.io/spec/version": REMOTESTORAGE_VERSION,
      "http://tools.ietf.org/html/rfc6749#section-4.2": config.authEndpoint,
      "http://tools.ietf.org/html/rfc6750#section-2.3": "false",
      "http://tools.ietf.org/html/rfc7233": "GET",
      "http://remotestorage.io/spec/web-authoring": null,
    },
  };
}
