# @dwk/microsub

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/dpop@0.1.0-beta.2
  - @dwk/indieauth@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/dpop@0.1.0-beta.1
  - @dwk/indieauth@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 7a34295: Add `@dwk/microsub` — a [Microsub](https://indieweb.org/Microsub-spec) server:
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

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- Updated dependencies [cdda653]
- Updated dependencies [171749e]
- Updated dependencies [28a1693]
- Updated dependencies [08cf029]
- Updated dependencies [589db69]
- Updated dependencies [818c101]
- Updated dependencies [6f446cd]
- Updated dependencies [2ef7e3c]
- Updated dependencies [44e82b5]
- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/dpop@0.1.0-beta.0
  - @dwk/indieauth@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
