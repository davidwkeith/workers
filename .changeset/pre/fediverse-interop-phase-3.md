---
"@dwk/activitypub": minor
"@dwk/micropub": minor
---

Fediverse interop phase 3 (#276): client wiring.

`@dwk/micropub` (#278):

- `syndicateTo` config now also accepts an **async provider**, so target
  lists can change at runtime (e.g. followed fediverse communities);
  `q=config` / `q=syndicate-to` await it.
- New `fediverse.ts` adapter: `entryToFediversePost` maps an `h-entry` onto
  the `POST <actor>/publish` wire shape (`photo`/`video`/`audio` → typed
  attachments with alt text, `name`+`content` → `article`, plain `content` →
  `note`, community target → titled `page` + `audience`), and `syndicateEntry`
  delivers to `@dwk/activitypub`'s publish endpoint when `mp-syndicate-to`
  names the reserved `fediverse` uid or an advertised community. Failures
  are logged per target, never fatal to the post creation. No
  `@dwk/activitypub` import — the JSON wire format is the contract.

`@dwk/activitypub` (#278/#279):

- `createCommunitySyndicationTargets` — an async `{uid, name}` provider of
  accepted `Group` follows (display handles like `!birding@lemmy.ml`),
  pluggable straight into micropub's `syndicateTo`; backed by a new
  internal-only `__following` DO route.
- MCP tools (v3): `activitypub_publish` (write-scoped, `PostInput` in,
  handle-shaped audiences resolved via the SSRF-guarded WebFinger lookup)
  and the read-only `activitypub_resolve` (handle → actor IRI + type +
  profile basics), beside the existing `activitypub_list_inbox`.
- New `discovery.ts` shared by the front door and the tools: guarded handle
  resolution and actor-document dereferencing.
