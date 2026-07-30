# `@dwk/activitypub` owner-admin endpoints: follower `Accept` + `Group` moderation

Issue: [#473](https://github.com/davidwkeith/workers/issues/473)

## Problem

Capability 4 (hosting `Group` actors, #376) shipped the *federated protocol*
side of membership approval and moderation — `manuallyApprovesFollowers`
config, and `Remove`-based moderation validated against an HTTP-signature-
verified `moderators` actor-IRI allowlist (`#onModerationRemove`,
`packages/activitypub/src/object.ts:886`) — but left no way for the **owner**
to trigger either one from outside the protocol.

- **Owner-publish** (`POST <actor>/outbox`, Bearer `publishToken`) only
  special-routes `Follow`/`Undo(Follow)` (`#routeRelationshipActivity`) and
  the follower-control set `Reject`/`Block`/`Undo(Block)`
  (`#routeFollowerControl`, #447). Any other activity type — including
  `Accept` and `Remove` — gets stored to the outbox and broadcast to every
  follower as ordinary content. `#onModerationRemove` only runs from the
  **inbound**, HTTP-signature-verified dispatch switch.
- Net effect: when `manuallyApprovesFollowers` is on, a pending follower is
  recorded in `followers` immediately (`#onFollow`,
  `packages/activitypub/src/object.ts:686-693`) but never gets the courtesy
  `Accept`. A `Group` owner has no way to ban a member or un-announce a post
  unless a genuinely separate third-party moderator's own AP server signs and
  delivers a `Remove` — which doesn't cover the primary case of an owner
  moderating their own hosted community from their own client (Anglesite).

## Non-goals

- **New HTTP routes or MCP tools.** Both new activity types route through the
  existing `POST <actor>/outbox` seam, already gated by the bearer
  `publishToken` in `handler.ts`. No changes to `handler.ts`, `config.ts`'s
  `INTERNAL_HEADERS`, or `mcp-tools.ts`.
- **Tracking "pending" follower state.** A manually-approved follower is
  already a full row in `followers` (existing behavior, unchanged by this
  issue). The owner identifies who to `Accept` from the existing
  `__client/notifications` / `activitypub_list_inbox` surfaces (a new
  follower is stored to `inbox` as a `follow` notification regardless of
  approval mode). No new "list pending followers" read is added.
- **Notifying a banned actor.** Matches existing inbound `#onModerationRemove`
  behavior: banning is local-only (drop from `followers`, insert into
  `banned`) with no outbound activity to the banned actor. Only un-announce
  fans out (`Undo(Announce)`, already implemented in `#removeAnnouncedPost`).

## Design

Both new cases live entirely in `packages/activitypub/src/object.ts`, using
the exact same wire shapes the protocol already defines for the equivalent
inbound/third-party-moderator activities — so an owner client and a
federated peer construct these activities identically.

### 1. Owner `Accept` — confirm a pending follower

Wire shape mirrors `Reject`'s (`#rejectTarget`,
`packages/activitypub/src/object.ts:1465`): `object` is the follower's actor
IRI, the stored `Follow` id, or an embedded `{type: "Follow", actor: "<iri>"}`.

```json
{ "type": "Accept", "object": "https://follower.example/users/alice" }
```

- **Rename `#rejectTarget` → `#singleFollowTarget`**: its target-resolution
  logic (bare string → look up by `followers.follow_id`, else treat as the
  actor IRI directly; embedded typed `Follow` → read `.actor`) is exactly
  what `Accept` needs too. No behavior change to the existing `Reject` call
  site, just a rename + a second caller.
- **Add an `Accept` branch to `#routeFollowerControl`** (renaming its doc
  comment to cover "single-target relationship activities" rather than only
  "follower-control"), structured like the `Reject` branch:
  1. Resolve the follower via `#singleFollowTarget`.
  2. **Require an existing `followers` row** for that actor (`SELECT
     follow_id FROM followers WHERE actor = ?`) — unlike `Reject`'s looser
     drift-repair fallback, confirming a follow that was never recorded
     doesn't make sense. No row ⇒ no-op (return `false`), matching the
     "unroutable → dropped" convention the other branches already use.
  3. Normalize `activity.object` to the canonical `Accept(Follow)` shape
     using the row's `follow_id` when present (same pattern `Reject` uses),
     `addressPrivately` to the follower alone, and — unless `deliver` is
     `false` (`?skipDelivery=1`) — `#enqueuePendingDelivery` + report `true`
     so `#publish` arms the alarm.
- **`isFollowerControlActivity`** gains `"Accept"` to its recognized set (and
  an updated doc comment) so `#publish` routes it away from outbox storage
  and follower fan-out, exactly like `Reject`/`Block`/`Undo(Block)` today.

Not `Group`-gated: manual follower approval is a general `Person`/`Group`
capability (spec "Members are followers ... including the
`manuallyApprovesFollowers` approval gate"), so `Accept` works for both actor
types.

### 2. Owner `Remove` — ban a member / un-announce a post

Wire shape is **identical** to the existing moderator-signed `Remove`
(`#onModerationRemove`): `target` disambiguates ban vs. un-announce, `object`
names the member or the `Announce` id.

```json
{ "type": "Remove", "object": "<member-iri>", "target": "<iris.followers>" }
{ "type": "Remove", "object": "<announce-id>", "target": "<iris.outbox>" }
```

- **Extract the shared core.** `#onModerationRemove`'s body *after* its
  authorization check becomes `#applyModerationRemove(activity, config,
  deliver: boolean)`:
  ```ts
  async #applyModerationRemove(
    activity: ActivityObject,
    config: ForwardedConfig,
    deliver: boolean,
  ): Promise<void> {
    if (config.actorType !== "Group") return;
    const object = objectId(activity.object);
    if (!object) return;
    const target = objectId(activity.target);
    if (target === config.iris.followers) {
      // ban: unchanged from today's #onModerationRemove body
      ...
      return;
    }
    if (target === config.iris.outbox) {
      await this.#removeAnnouncedPost(object, config, deliver);
    }
  }
  ```
  `#onModerationRemove` (inbound path) keeps its own
  `config.moderators.includes(moderator)` check, then calls
  `#applyModerationRemove(activity, config, /* deliver */ true)` — inbound
  moderation has no backfill concept, so it always delivers.
- **`#removeAnnouncedPost` gains a `deliver: boolean = true` parameter**: the
  outbox delete + inbox tombstone always apply; the `Undo(Announce)`
  fan-out loop + `#armAlarm()` are skipped when `deliver` is `false`.
- **New branch in `#publish()`**, placed immediately after the existing
  `isFollowerControlActivity` check and before the outbox `INSERT` — same
  position in the function, same reason (never stored to the publicly-served
  outbox, never broadcast). `Remove` is *not* added to
  `isFollowerControlActivity` itself — its delivery model differs: ban has
  no delivery at all, and un-announce's fan-out is a broadcast to the whole
  membership, not a single target:
  ```ts
  if (activity.type === "Remove") {
    if (config.actorType !== "Group") {
      return text(400, "`Remove` moderation requires a Group actor");
    }
    await this.#applyModerationRemove(activity, config, !skipDelivery);
    return json(202, activity as JsonValue);
  }
  ```
  No `config.moderators` check here — bearer `publishToken` auth at the
  front door is authorization enough; the owner is implicitly the top
  moderator of their own actor. This is a real behavioral difference from
  the inbound path, not just a convenience: an owner `Remove` succeeds even
  when `moderators` is empty or doesn't list the owner's own actor IRI.

The explicit `400` on a non-`Group` actor (rather than the inbound path's
silent drop) is a deliberate asymmetry: the inbound path stays opaque to an
unauthorized/inapplicable third party by design, but an owner client making
a real mistake (calling this on a `Person` actor) deserves a clear answer.

### 3. Required fix: `#asOutboxActivity`'s activity allowlist

`#asOutboxActivity` (`packages/activitypub/src/object.ts:1642`) decides
whether caller input is "already a real activity" (passed through, actor/id
overwritten) or "a bare object" (wrapped in a synthetic `Create`). Its
`isActivity` list currently reads:

```ts
["Create", "Update", "Delete", "Announce", "Like", "Dislike", "Follow", "Undo", "Block", "Reject"]
```

`"Accept"` and `"Remove"` are missing. Without adding them, an owner-published
`Accept`/`Remove` gets wrapped inside a `Create` before the new `#publish`
branches ever see it — a required fix, not an enhancement.

## Data flow

```
Owner client (Anglesite)
  │ POST <actor>/outbox
  │ { "type": "Accept", "object": "<follower-iri>" }
  ▼
handler.ts — unchanged: bearer publishToken check, forwards to DO
  ▼
object.ts #publish
  - #asOutboxActivity: "Accept" ∈ isActivity ⇒ pass through, actor := iris.id
  - isFollowerControlActivity ⇒ true ⇒ #routeFollowerControl
    - #singleFollowTarget resolves the follower
    - followers row exists ⇒ normalize Accept(Follow), address privately
    - #enqueuePendingDelivery + #armAlarm()
  ▼
202 { the normalized Accept(Follow) activity }
  (delivered to the follower's inbox from the alarm, like every other
   outbound actor fetch)
```

```
Owner client (Anglesite)
  │ POST <actor>/outbox
  │ { "type": "Remove", "object": "<member-iri>", "target": "<iris.followers>" }
  ▼
handler.ts — unchanged
  ▼
object.ts #publish
  - #asOutboxActivity: "Remove" ∈ isActivity ⇒ pass through, actor := iris.id
  - activity.type === "Remove" branch (new, not via isFollowerControlActivity)
    - config.actorType !== "Group" ⇒ 400
    - #applyModerationRemove(activity, config, deliver=true)
      - target === iris.followers ⇒ DELETE followers, INSERT banned
  ▼
202 { the Remove activity }
```

## Error handling

- Owner `Remove` on a non-`Group` actor → `400` with a precise message.
- Owner `Accept` for an actor with no `followers` row → silent no-op, `202`
  (matches the existing `Reject`/`Block` "unroutable → dropped" convention;
  this is a normal race — e.g. the follower unfollowed between the owner
  seeing the notification and clicking Accept — not an error condition).
- `?skipDelivery=1` behaves identically to today's documented meaning for
  `Reject`/`Block`: the local state change always applies; only the outbound
  federated notification is suppressed. For `Accept` that means no `Accept`
  is delivered; for `Remove`/un-announce it means no `Undo(Announce)`
  fan-out (the ban branch has no delivery to suppress either way).
- No new authorization surface: both new activity types reach the DO only
  after the front door's existing bearer-token publish gate.

## Testing

Extend `packages/activitypub/src/object.test.ts` alongside the existing
`Reject` tests (~line 1764) and the moderator-`Remove` test (~line 2573):

- Owner `Accept` delivers a canonical `Accept(Follow)` to the follower's
  inbox alone (not broadcast), using the stored `follow_id` when present.
- Owner `Accept` accepts the actor-IRI shorthand, the stored `Follow` id, and
  an embedded `Follow` object — the same three shapes `Reject` accepts.
- Owner `Accept` no-ops (still `202`, no queued delivery, no alarm armed)
  when the actor has no `followers` row.
- Owner `Accept` with `?skipDelivery=1` applies no delivery (nothing to queue
  either way here, since there's no local state change on `Accept` — this
  test just confirms the header is honored without error).
- Owner `Remove` targeting `followers` bans the member (`followers` row
  gone, `banned` row present) without requiring the owner's actor IRI in
  `config.moderators`.
- Owner `Remove` targeting `outbox` un-announces: outbox row gone, inbox
  tombstoned (`removed_at` set), `Undo(Announce)` queued to every follower.
- Owner `Remove` with `?skipDelivery=1` on an un-announce: outbox/inbox
  mutations still apply, but no `Undo(Announce)` queued and no alarm armed.
- Owner `Remove` on a `Person` actor (default `actor.type`) answers `400`.
- Inbound moderator-signed `Remove` behavior is unchanged (existing tests at
  ~line 2573 and around `#onModerationRemove` continue to pass unmodified —
  a regression check that the extraction didn't change inbound semantics).
- `#asOutboxActivity` passes `Accept`/`Remove` through as real activities
  (not wrapped in a synthetic `Create`) — a direct unit test of the
  allowlist fix, since every behavioral test above would also silently fail
  in a confusing way if this regressed.

## Open questions

None — both design forks (HTTP surface choice; whether owner `Remove`
requires the owner's actor IRI in `config.moderators`) were confirmed with
the repo owner during brainstorming.
