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
- **Owner follower control (#447).** `Reject`(Follow), `Block` and
  `Undo(Block)` published to `POST <actor>/outbox` are _follower-control_
  activities: they route to one actor's inbox through the targeted queue
  (`#routeFollowerControl`), never the follower fan-out, and are never written
  to the publicly-served outbox. A `Block` also persists to the `blocked` table,
  and every inbound activity from a blocked actor is refused `403` — distinct
  from `banned`, which is a `Group` moderator's decision and is not reversible
  through this path. Owner `Accept` (confirm a pending follower) and
  `Group`-moderation `Remove` (ban a member / un-announce a post) follow the
  identical `POST <actor>/outbox` pattern (#473) — see `object.ts`
  `#routeFollowerControl`'s `Accept` branch and `#applyModerationRemove`.
  `GET <actor>/follow_requests` (#487) lists pending followers behind the same
  bearer token, mirroring `/blocked` — a bearer-gated equivalent of the
  internal-marker-gated `__client/follow_requests` route `@dwk/mastodon-api`
  uses, so an owner client doesn't need OAuth just to see who is pending.
  `GET <actor>/reports` (#489) lists open inbound `Flag` reports the same
  way (paginated, unlike `/blocked`/`/follow_requests`, since reports arrive
  from arbitrary peers); the owner resolves one via `POST <actor>/outbox`
  with `{ "type": "Ignore", "object": "<flag-id>" }`, mirroring `Accept`/
  `Remove`. `Ignore` only tombstones the report (`resolved_at`); it stays
  hard-deleted only once `reportRetentionMs` (config `reportRetentionDays`,
  default 30) elapses — a `report_prune` queue row scheduled at resolution
  time and swept from the alarm (#502), the same off-critical-path pattern
  as `pending_accept`/`verify_queue`/`actor_profile_queue`.
- **Hosting `Group` actors (#376).** `actor.type: "Group"` hosts a FEP-1b12
  community: members are `followers` (a `Follow`, or a `Join`/`Leave` targeting
  the Group actor itself rather than one of its owned events, is the same
  `Follow`/`Undo(Follow)` path); a member's `Create` is wrapped in a
  Group-authored `Announce` and fanned out to the membership; and a
  `moderators` actor-IRI allowlist authorizes AS2 `Remove`-based moderation
  (ban a member / un-announce a post — see `object.ts` `#onModerationRemove`).
