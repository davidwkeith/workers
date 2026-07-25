# @dwk/microsub

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/dpop@1.0.0-beta.1
  - @dwk/indieauth@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1
  - @dwk/mcp@1.0.0-beta.1
  - @dwk/mf2@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1

## 0.1.0-beta.5

### Minor Changes

- 55fa4c3: Extract the `h-entry` microformats extractor into a new shared lib, `@dwk/mf2`,
  and use it to enrich received Webmentions (#412).

  - **`@dwk/mf2` (new):** `parseHEntries` — the `HTMLRewriter`-based `h-entry` /
    `h-card` → JF2 extractor moved out of `@dwk/microsub`'s `hfeed.ts` — now also
    recognizes `u-repost-of` / `u-bookmark-of` and captures `e-content` inner
    HTML alongside its text. Ships `sanitizeHtml`, an allowlist sanitizer for
    that captured UGC (formatting tags only, all attributes stripped except a
    validated `a[href]`, `rel="ugc nofollow"` forced onto surviving links,
    text-length truncation), `decodeEntities` (this runtime's `HTMLRewriter`
    hands back raw, undecoded values, so URL/date/plain-text properties decode
    before they are interpreted — an `href` of `…?a=1&amp;b=2` matches the
    target `…?a=1&b=2` — while captured HTML stays encoded), and
    `fnv1aBase36`, the stable-id hash.
  - **`@dwk/microsub`:** consumes `@dwk/mf2` for `parseHFeed` instead of owning
    the extractor; behavior and public surface unchanged (`Jf2Entry` gains
    optional `repost-of` / `bookmark-of`).
  - **`@dwk/webmention`:** verified mentions are enriched from the one `h-entry`
    responding to the target — `interactionType`
    (reply / like / repost / bookmark / mention, precedence reply > repost >
    like > bookmark), `author`, sanitized+truncated `content` HTML, and
    `publishedAt` (declared `dt-published`, else the verification time). The D1
    inbox gains additive nullable columns (`id`, `interaction_type`,
    `author_name`, `author_url`, `author_photo`, `content`, `published_at`) with
    the same `ALTER TABLE` migration pattern as `rsvp`; `id` is a stable
    `wm-{hash}` over `(source, target)` (exported as `mentionId`).
    `VerifiedMention`, `VerifyResult`, and the `webmention_list_received` MCP
    tool output all carry the new fields.

### Patch Changes

- 427064c: `sanitizeHtml` now rewrites `<img>` to a link to its `src` labeled by its
  `alt` text (same href validation and forced `rel="ugc nofollow"` as any
  link), so a photo reply no longer sanitizes to empty content while nothing
  in stored snapshots auto-fetches attacker-controlled URLs on render; and
  demotes headings `h1`–`h6` to `<p><strong>` bold paragraphs so received
  content can never out-rank the embedding page's own heading hierarchy.
  `@dwk/webmention` mention enrichment and `@dwk/microsub` timeline content
  pick up the new behavior at capture time.
- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [dc59912]
- Updated dependencies [427064c]
- Updated dependencies [55fa4c3]
- Updated dependencies [4cd36af]
  - @dwk/dpop@0.1.0-beta.4
  - @dwk/mf2@0.1.0-beta.0
  - @dwk/indieauth@0.1.0-beta.5
  - @dwk/log@0.1.0-beta.5
  - @dwk/mcp@0.1.0-beta.1
  - @dwk/safe-fetch@0.1.0-beta.4

## 0.1.0-beta.4

### Minor Changes

- 04e16c2: Add `createMicrosubMcpTools` (#240): read-only `@dwk/mcp` tool contributions
  `microsub_list_channels` (channels + unread counts) and
  `microsub_get_timeline` (a page of a channel's JF2 entries, newest first),
  both thin wrappers over the same `MicrosubStore` the HTTP `channels`/
  `timeline` `GET` actions use. Timeline entries originate from feeds the user
  follows, so the tool description documents the prompt-injection surface —
  an agent must treat entry content as untrusted data, never as instructions.
  Defaults `requiredScope` to `""`, matching the HTTP `GET` actions, which
  require no specific scope beyond a valid, authenticated caller. A
  caller-supplied `limit` on `microsub_get_timeline` is clamped to a
  configurable `maxLimit` (default 100) so an agent can't force an unbounded
  D1 read.
- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).

### Patch Changes

- 36a3be1: Bind the DPoP proof's `htu` to the configured endpoint URL instead of
  `request.url` (#300). Both resource servers verified the proof against
  `request.url`, but a client signs the **public** endpoint it POSTs to — behind
  the path-rewriting proxy the mountable-prefix composition targets, `request.url`
  is the rewritten internal URL, so every DPoP proof failed with `htu_mismatch`, a
  hard outage. `authorize` now takes the expected `htu` from the caller and each
  call site passes the relevant configured endpoint (`micropubEndpoint` /
  `mediaEndpoint` / `microsubEndpoint`), matching what `@dwk/indieauth`'s token
  endpoint already does.
- bde0341: Create D1 schema lazily so a fresh deploy no longer 500s (#291, #292). The
  IndieAuth code/token store, the Micropub post store, and the Micropub/Microsub
  DPoP replay stores previously created their tables only in an `init()` that no
  handler ever called, so a consumer composing these packages against a brand-new
  D1 hit `no such table` on the first authorization/token/publish request, and —
  because DPoP replay-checking is on by default — every authenticated
  create/update/delete `500`ed permanently.

  Each store now materialises its schema lazily on first use (the same
  `ensureSchema` pattern the webmention/websub/microsub stores already use), with
  the cached init promise cleared on failure so a transient D1 error doesn't wedge
  the store. The IndieAuth RFC 8707 `resource`-column migration now runs on that
  lazy path too, so it actually reaches consumer databases. No separate migration
  step is required.

- 36a3be1: Persist a feed's conditional-fetch validators only after its entries are stored
  (#302). The poll consumer wrote the `ETag`/`Last-Modified` cache before
  `insertItems`, so a transient insert failure (which retries the message) meant
  the retry re-fetched with the already-updated validators, got a `304`, and
  permanently dropped the entries it never stored. The cache is now written after
  a successful insert (which dedups by entry id, so the re-insert on retry is
  idempotent), and a `304` that omits validators keeps the previously-cached ones
  instead of nulling them.
- 3e505be: Queue consumers now back off exponentially (30s base, doubling per attempt,
  capped at 1h) when retrying a `message.retry()`, based on `message.attempts`.
  Previously a bare `message.retry()` re-delivered at the queue's default
  cadence indefinitely, hammering an unreachable source/feed/callback instead of
  backing off.
- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [bde0341]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/indieauth@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- 3e7e9d2: Drop the redundant in-batch `CREATE TABLE IF NOT EXISTS` from
  `recordProof`'s D1 batch in the DPoP replay store — `init()` already creates
  the schema, and `@dwk/micropub`'s twin implementation never repeats it in the
  hot path. Purely a consistency fix; behavior is unchanged since the statement
  was idempotent.
- 22c802a: Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
  package instead of a package-local copy. No public API change.
- Updated dependencies [6d14fc3]
- Updated dependencies [7b86416]
- Updated dependencies [22c802a]
  - @dwk/indieauth@0.1.0-beta.3
  - @dwk/dpop@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.3
  - @dwk/safe-fetch@0.1.0-beta.2

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
