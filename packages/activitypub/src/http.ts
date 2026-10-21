/**
 * Shared constants for outbound fediverse HTTP requests. A leaf module (no
 * imports) so `config.ts`, `delivery.ts`, and `discovery.ts` can all depend on
 * it without a cycle.
 */

/**
 * Default `User-Agent` for every outbound fediverse HTTP request this package
 * makes (key resolution, delivery, discovery). Many peers — and the
 * anti-scraper challenge layers (e.g. Anubis) a growing number of hosts put in
 * front of federated software — allow- or deny-list on this header; an
 * unidentified client is often treated as a bot and challenge-looped rather
 * than served (see https://github.com/TecharoHQ/anubis/issues/31). Sending a
 * descriptive one is standard ActivityPub interop practice and costs nothing.
 */
export const DEFAULT_USER_AGENT =
  "@dwk/activitypub (+https://github.com/davidwkeith/workers/tree/main/packages/activitypub)";
