# @dwk/webmention

Webmention receiver and sender endpoint.

## What this is

Receives webmentions (source + target URL pairs), synchronously validates
parameters, returns 202 Accepted, then asynchronously verifies that the source
actually links to the target via a queue consumer. Stores verified mentions in a
D1 inbox. Also provides a sender module for outbound endpoint discovery and
notification on publish. Includes documented Bridgy Fed federation support.

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
src/index.ts        # public surface: createWebmention, queue consumer, sender, validation, types
src/handler.ts      # createWebmention factory (receiver endpoint)
src/validation.ts   # sync parameter validation (source, target)
src/discovery.ts    # endpoint discovery for sending
src/sender.ts       # sendWebmention, sendWebmentions
src/verify.ts       # async source verification (link checking)
src/store.ts        # createD1Inbox (D1-backed mention storage)
src/safe-fetch.ts   # SSRF-safe fetch with private IP blocking
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
