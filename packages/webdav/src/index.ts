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
 * This entry point now also exposes the **Class 2 verb router** and the
 * authoritative DO-SQLite state it drives:
 *
 * - {@link createWebdav} — the RFC 4918 Class 2 request handler, translating
 *   WebDAV verbs into the injected {@link WebdavBackend} seam (spec "Verb
 *   surface").
 * - {@link LockStore} — exclusive write locks in DO SQLite (spec §2).
 * - {@link CredentialStore} — app-password persistence + throttled verification
 *   (spec §1).
 * - {@link PropertyStore} — dead-property storage in DO SQLite (spec §4).
 *
 * The concrete adapter that resolves {@link WebdavBackend} onto the per-pod
 * `SolidPodObject` (hosting the lock + app-password tables alongside the Solid
 * write path) is supplied by the composing Worker; keeping the seam injectable
 * is what lets the router unit-test without standing up the whole pod DO.
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
  type IfCondition,
  type IfList,
  submittedLockTokens,
  type IfHeaderResult,
} from "./if-header.js";

export {
  DEFAULT_PBKDF2_ITERATIONS,
  PBKDF2_ITERATION_CEILING,
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

export {
  resolveLockPolicy,
  CollectionNotEmpty,
  PreconditionFailed,
  ResourceConflict,
  type AppPasswordPolicy,
  type CredentialApi,
  type DeadProperty,
  type DeadPropertyApi,
  type LockApi,
  type LockPolicy,
  type ResolvedLockPolicy,
  type ResourceBody,
  type ResourceStat,
  type WebdavBackend,
  type WebdavConfig,
  type WebdavEnv,
  type WebdavMode,
  type WriteOutcome,
  type WritePreconditions,
} from "./config.js";

export {
  LockStore,
  effectiveTimeout,
  parseTimeoutHeader,
  type AcquireParams,
  type AcquireResult,
  type LockRecord,
} from "./locks.js";

export {
  CredentialStore,
  type ThrottlePolicy,
  type VerifyResult,
} from "./credential-store.js";

export { PropertyStore } from "./dead-props.js";

export { createWebdav, type WebdavHandler } from "./webdav.js";
