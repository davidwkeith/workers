# @dwk/webmention

Webmention receiver and sender endpoint.

## What this is

Receives webmentions (source + target URL pairs), synchronously validates
parameters, returns 202 Accepted, then asynchronously verifies that the source
actually links to the target via a queue consumer. Stores verified mentions in a
D1 inbox. Also provides a sender module for outbound endpoint discovery and
notification on publish. Includes documented Bridgy Fed federation support.
Also contributes a read-only `@dwk/mcp` tool (`createWebmentionMcpTools` →
`webmention_list_received`) over the same `InboxStore` the queue consumer
writes into.

## Spec

`spec/packages/webmention.md` — authoritative requirements.

## Key constraints

- **Async verification.** The receiver endpoint validates parameters synchronously
  but does NOT fetch the source page in-request. Verification happens via a queue
  consumer (`createWebmentionQueueConsumer`).
- **SSRF protection.** Source verification uses `safeFetch` with private/reserved
  host blocking — never follow redirects to internal IPs.
- **D1 inbox.** Verified mentions live in D1 (`WEBMENTION_INBOX`). The store
  supports upsert (same source+target updates the existing record).
- **Enrichment is sanitized at capture.** Verified mentions carry
  interactionType/author/content/publishedAt read from the source's mf2 via
  `@dwk/mf2`, scoped to the one `h-entry` responding to _our_ target; content
  HTML goes through `@dwk/mf2`'s allowlist `sanitizeHtml` (rel="ugc nofollow"
  forced) and is truncated before it reaches D1.
- **Queue binding required.** `WEBMENTION_QUEUE` must be bound in the Worker env
  for async processing. Fail loudly if missing.
- **Sender is separate.** The sender module (`sendWebmention`/`sendWebmentions`)
  discovers endpoints via link-rel parsing and sends outbound mentions. It's
  independent of the receiver.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- D1: `WEBMENTION_INBOX`

```bash
pnpm test --project @dwk/webmention
```

## File layout

```
src/index.ts        # public surface: createWebmention factory + queue consumer, config/Env, mcp tools, types
src/validate.ts     # sync parameter validation (source, target)
src/discovery.ts    # endpoint discovery for sending (Link header + HTML)
src/sender.ts       # sendWebmention, sendWebmentions
src/verify.ts       # async source verification (link checking)
src/inbox.ts        # InboxStore interface, createD1Inbox (D1-backed mention storage)
src/mcp-tools.ts    # createWebmentionMcpTools — the `webmention_list_received` @dwk/mcp tool
src/rsvp.ts         # Indie RSVP recognition (p-rsvp + u-in-reply-to extraction)
src/enrich.ts       # mention enrichment (interaction type, author, sanitized content)
src/html.ts         # Link-header parsing + HTMLRewriter scanning helpers
src/log.ts          # structured observability event taxonomy (@dwk/log vocabulary)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
- `@dwk/mcp` — `ToolDefinition`/`ToolCallResult` types for `mcp-tools.ts`.
- `@dwk/mf2` — the shared `h-entry` extractor + `sanitizeHtml` allowlist
  sanitizer behind `enrich.ts`, and the `fnv1aBase36` hash behind `mentionId`.
- `@dwk/safe-fetch` — SSRF-safe fetch (`safeFetch`, `readBodyCapped`,
  `FetchLike`) with private/reserved IP blocking; re-exported from
  `index.ts` for backwards compatibility.
