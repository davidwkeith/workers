# @dwk/activitypub

ActivityPub actor — endpoint + Durable Object for fediverse federation.

## What this is

Native ActivityPub actor rooted at the user's domain. Per-actor Durable Object
manages inbox/outbox/followers/following collections with SQLite. Handles
inbound `POST /inbox` with HTTP signature verification (RFC 9421 + draft-cavage),
activity deduplication, and activity-type handlers (Follow, Undo, Create, Update,
Like, Announce, Delete). Outbound delivery retries via DO alarms with backoff.
Serves actor documents, collection pages, and NodeInfo for fediverse discovery.
Also contributes a read-only `@dwk/mcp` tool (`createActivitypubMcpTools` →
`activitypub_list_inbox`) over a new internal-only DO route — the public
`/inbox` stays write-only to peers.

## Spec

`spec/packages/activitypub.md` — authoritative requirements.

## Key constraints

- **HTTP signature verification on inbox.** Every inbound activity must have a
  valid HTTP signature. The `KeyResolver` callback fetches the sender's public
  key (typically from their actor document). Signature verification covers
  method, target URI, host, date, and content digest.
- **Activity deduplication.** Inbound activities are deduped by their `id` in
  the DO's SQLite store to prevent replay.
- **Delivery retries.** Outbound delivery failures trigger DO alarm-based retries
  with exponential backoff. Failed deliveries are not silently dropped.
- **Inbox resolution off the critical path.** Auto-`Accept`-on-`Follow`/`Join`
  never resolves the remote actor's inbox inline — that's an outbound fetch
  that would hold the single-threaded DO's input gate open against every other
  request to that actor. It's queued (`pending_accept`) and resolved from the
  alarm alongside ordinary delivery retries (`object.ts` `#processPendingAccepts`).
- **JSON-LD AS2 content type.** Requests and responses use
  `application/activity+json` or `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`.
  The `wantsActivityJson` helper detects Accept header preference.
- **NodeInfo.** Serves `/.well-known/nodeinfo` and NodeInfo 2.0/2.1 documents
  for fediverse software discovery (software name, version, usage counts).
- **No WAC leakage.** This is an ActivityPub package — WAC/Solid concepts must
  not leak in, even though both share `@dwk/ldn` for inbox primitives.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- DO: `ActivityPubObject` (useSQLite)
- Compatibility flags: `nodejs_compat`

Has `test-harness.ts` (excluded from build and published files).

```bash
pnpm test --project @dwk/activitypub
```

## File layout

```
src/index.ts        # public surface: createActivityPub, ActivityPubObject, AS2, nodeinfo, delivery, types
src/config.ts       # ActivityPubConfig type, Env fragment, IRI derivation
src/handler.ts      # createActivityPub factory (actor/inbox/outbox/collection routes)
src/object.ts       # ActivityPubObject Durable Object (inbox/outbox/followers/following)
src/as2.ts          # actor document builder, collection/page builders, AS2 helpers
src/objects.ts      # typed post objects: PostInput → Note/Article/Page builders, inbox classification (#274)
src/discovery.ts    # SSRF-guarded handle→actor resolution + actor-doc fetch (§2.4)
src/syndication.ts  # followed-community {uid,name} provider for micropub's syndicateTo (#278)
src/events.ts       # CalendarEvent ↔ AS2 Event adapter + Join/Leave RSVP helpers (#171)
src/nodeinfo.ts     # NodeInfo 2.0/2.1 discovery and documents
src/signature.ts    # HTTP signature signing/verification (draft-cavage profile)
src/delivery.ts     # outbound activity delivery with SSRF guard (retry lives in the DO)
src/mcp-tools.ts    # createActivitypubMcpTools — activitypub_publish (write), activitypub_resolve + activitypub_list_inbox (read)
src/mastodon-api.ts # createActivitypubMastodonApi — composes @dwk/mastodon-api's router over the internal __client/* seam (#349)
src/log.ts          # structured logging/metrics event vocabulary
src/body.ts         # capped read for inbound request bodies (inbox/publish)
src/test-harness.ts # test-only DO class (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/calendar` — canonical event model (the AS2 `Event` adapter reads it).
- `@dwk/ldn` — inbox discovery and notification primitives.
- `@dwk/log` — structured logging.
- `@dwk/mastodon-api` — `createMastodonApi`, the `MastodonBackend` seam, and
  the snowflake codec `mastodon-api.ts` composes over the internal DO seam
  (phase 2, #349).
- `@dwk/mcp` — `ToolDefinition`/`ToolCallResult` types for `mcp-tools.ts`.
- `@dwk/webfinger` — the `lookup.ts` client half (handle → actor IRI), wired
  through the SSRF-guarded fetch for community discovery (#275/§2.4).

(Also uses `@dwk/http-signatures` indirectly via its own signature module.)
