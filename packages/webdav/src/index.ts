/**
 * `@dwk/webdav` — a WebDAV (RFC 4918, **Class 2**) façade over a Solid pod.
 *
 * The storage a user already owns, mounted as a network drive by the file
 * managers built into every major OS (macOS Finder, Windows Explorer, the
 * GNOME/KDE managers, iOS Files) — zero install, no app. It is **one pod, a
 * second door**: WebDAV exposes the *same* resources `@dwk/solid-pod` serves,
 * not a parallel tree, so the files you reach in Finder *are* your pod.
 *
 * This entry point currently exposes the **protocol core** — the pure,
 * Workers-runtime-free primitives the eventual `createWebdav` factory composes:
 *
 * - {@link parseXml} / {@link escapeXml} — the hand-rolled, bounded, XXE-safe
 *   XML generator and parser (spec §4).
 * - {@link parseIfHeader} — the strict-subset `If:` precondition parser (§4).
 * - {@link mintAppPassword} / {@link verifyAppPassword} — the scoped
 *   app-password auth bridge, hashed at rest with PBKDF2-HMAC-SHA-256 (§1).
 * - {@link inferContentType} / {@link isOsLitter} — OS-client quirk handling
 *   (§3).
 *
 * The `createWebdav` request handler, Class 2 locking, and the per-pod
 * Durable Object integration (lock table + app-password store inside
 * `SolidPodObject`) land in subsequent increments; the lock state and credential
 * hashes are net-new authoritative state and MUST live in the same per-pod DO as
 * the Solid write path (spec §2).
 *
 * @see spec/packages/webdav.md
 * @packageDocumentation
 */

export {
  DAV_NS,
  XmlError,
  escapeXml,
  parseXml,
  firstChild,
  childrenNamed,
  type XmlElement,
  type XmlParseLimits,
} from "./xml.js";

export {
  parseIfHeader,
  type IfHeaderCondition,
  type IfHeaderResult,
} from "./if-header.js";

export {
  DEFAULT_PBKDF2_ITERATIONS,
  generateCredentialId,
  generateSecret,
  mintAppPassword,
  verifyAppPassword,
  timingSafeEqual,
  parseBasicAuthorization,
  isHttpsRequest,
  type AppPasswordScope,
  type AppPasswordRecord,
  type MintedAppPassword,
  type MintAppPasswordParams,
  type BasicCredential,
} from "./credentials.js";

export { inferContentType } from "./content-type.js";

export { DEFAULT_OS_LITTER, isOsLitter } from "./litter.js";
