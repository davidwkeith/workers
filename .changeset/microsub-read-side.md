---
"@dwk/microsub": minor
---

Add `@dwk/microsub` — a [Microsub](https://indieweb.org/Microsub-spec) server:
the IndieWeb **read side**, completing the loop alongside `@dwk/micropub`
(write), `@dwk/webmention` (interaction), `@dwk/indieauth` (identity), and
`@dwk/websub` (push).

- **`createMicrosub(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler, mountable under a path
  prefix. A single endpoint dispatches on the `action` (and `method`) parameter:
  - **Channels** — list / create / rename / delete (`method=delete`) / reorder
    (`method=order`), with a reserved `notifications` channel that cannot be
    deleted or renamed.
  - **Following** — `follow` / `unfollow` with feed discovery (Atom / RSS / JSON
    Feed / `h-feed`); a follow populates the timeline immediately and primes the
    poll cache.
  - **Timeline** — JF2 entries with `before` / `after` opaque cursors,
    `mark_read` / `mark_unread` (`entry`, `entry[]`, or `last_read_entry`),
    `remove`, and per-channel unread counts.
  - **Search / preview** — discover or preview a feed without subscribing.
- **Auth** reuses `@dwk/micropub`'s posture: the same DPoP-bound IndieAuth access
  tokens, the single-owner subject (`me`) check, revocation against the
  strongly-consistent issued-token store, and replay detection on state-changing
  requests.
- **`createMicrosubPoller(config)`** (a Cron `scheduled` handler) enqueues one
  poll job per distinct followed feed; **`createMicrosubQueueConsumer(config)`**
  fetches each conditionally (`ETag` / `Last-Modified`), parses to JF2, dedupes,
  and appends to every channel following it — all off the read path.
- Subscriptions, timeline, and read-state live in **D1** (strongly consistent,
  never KV); paging uses a monotonic `seq` cursor. Every outbound fetch is
  **SSRF-guarded** (private/loopback/link-local hosts blocked, redirects
  re-validated, body size-capped). Discovery / observability flow through the
  `@dwk/log` `Logger` / `Metrics` seams.

Bindings (declared `Env` fragment, fails loudly if missing): `MICROSUB_DB` (D1),
`MICROSUB_QUEUE` (Queue), `AUTH_DB` (the `@dwk/indieauth` token store), and
`TOKEN_SIGNING_KEY`.
