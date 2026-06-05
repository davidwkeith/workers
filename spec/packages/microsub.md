# `@dwk/microsub`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Microsub](https://indieweb.org/Microsub-spec) |
| **Status** | proposed — tracked in [#91](https://github.com/davidwkeith/workers/issues/91) |

A Microsub server: the **read side** of the IndieWeb, completing the loop the
other endpoint packages leave open. [`@dwk/micropub`](micropub.md) is the write
side, [`@dwk/webmention`](webmention.md) the interaction side,
[`@dwk/websub`](websub.md) the publish/push side — Microsub is the
**subscription + timeline** side: it manages a user's feed subscriptions
(organised into channels), polls and parses those sources server-side, and
serves a normalised timeline to reader clients (Monocle, Together, Indigenous)
so the reading state lives on infrastructure the user owns rather than in a
hosted aggregator.

## Worker vs. Anglesite (the static split)

Microsub is **fully dynamic** — there is nothing for the static site generator
to emit. Anglesite's role is limited to advertising the endpoint: the identity
page carries `<link rel="microsub" href="…">` so reader clients can discover it
(the same discovery pattern Anglesite already emits for `authorization_endpoint`
/ `token_endpoint` / `micropub`). Everything below is request logic a static
host cannot do:

- channel CRUD and ordering;
- per-source polling, fetch, and microformats2 parsing into JF2 timeline items;
- read/unread tracking and timeline pagination.

## Functional requirements

- Export `createMicrosub(config)` returning the standard handler, mountable
  under a path prefix as the single Microsub endpoint (all actions are
  `action=`/`method=` parameters on one URL).
- **Auth:** every request is authenticated with an IndieAuth bearer token
  (reuse the validation path that [`@dwk/indieauth`](indieauth.md) issues and
  [`@dwk/micropub`](micropub.md) consumes); requests require an appropriate
  scope and the token's `me` must match the server's identity.
- **Channels** (`action=channels`): list, create, update (rename), delete, and
  **reorder** channels. Reserve the built-in `notifications` channel.
- **Following** (`action=follow` / `unfollow` / `action=follow` list): manage
  the set of feeds within a channel; on follow, **discover** the feed (Atom /
  RSS / JSON Feed / `h-feed`) for the given URL.
- **Timeline** (`action=timeline`): return JF2 entries for a channel with
  `before` / `after` cursor pagination; support `action=timeline` `method=mark_read`
  / `mark_unread` and per-channel **unread counts**.
- **Search / preview** (`action=search`, `action=preview`): resolve a query or a
  URL to candidate feeds / a preview timeline without subscribing.
- **Polling:** fetch each followed source on a schedule, parse to JF2, dedupe
  against already-stored entries, and append new items to the owning channel's
  timeline.

## Design constraints

- The subscription + timeline store **MUST** be strongly consistent — D1
  (session consistency), **never KV**: a lost subscription or a read/unread flag
  that silently rolls back is a correctness bug, not a safe-to-be-stale cache
  ([non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- **Polling runs on a schedule via a queue / Cron Trigger with backoff**, never
  inline on the `action=timeline` read path — the read path serves stored
  entries only, so a slow or dead source never blocks a client.
- **Reuse, don't re-implement, microformats2 parsing:** the mf2 → JF2 path
  already exists in [`@dwk/micropub`](micropub.md)'s `mf2.ts`; factor the shared
  parsing out rather than forking it. RSS / Atom / JSON Feed normalisation to
  JF2 is the new surface this package adds.
- **Complements, does not duplicate, [`@dwk/websub`](websub.md):** where a
  followed source advertises a `rel="hub"`, the poller MAY subscribe via WebSub
  for push instead of polling that source — WebSub is the user as *subscriber*
  here, the mirror of the hub role `@dwk/websub` plays for the user's own feed.

## Bindings (declared `Env` fragment)

- **D1** for channels, follows, and timeline entries (with read state).
- A **queue** (and/or Cron Trigger) for scheduled polling and parse fan-out.
- Optional **R2** for cached source bodies / media if entries grow past the
  practical D1 row ceiling.

## Config

- `baseUrl` / domain and the identity (`me`) the server authenticates against.
- IndieAuth token-validation settings (issuer / introspection), shared with
  `@dwk/micropub`.
- Polling cadence bounds and per-channel source caps.
- Default channels to seed.

## Conformance / testing

- There is no hosted conformance suite for Microsub (unlike micropub.rocks /
  webmention.rocks). Validate against the published spec and **interop with real
  reader clients** — Monocle, Together, Indigenous — plus colocated unit tests
  over the channel/timeline state machine and the feed → JF2 parsers. See
  [conformance-and-testing.md](../conformance-and-testing.md).
</content>
</invoke>
