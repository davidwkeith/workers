# @dwk/micropub

Micropub publishing protocol endpoint.

## What this is

Handles create/update/delete of posts via the Micropub protocol. Accepts both
form-encoded and JSON request bodies, parses Microformats 2 (mf2) objects,
and stores posts in D1. Includes an R2-backed media endpoint for file uploads.
Requires IndieAuth access tokens with scope-based authorization — `create`,
`update`, `delete`, `media` scopes. Supports `q=config`, `q=source` (single-post
and list with offset pagination), and `q=category` queries. Also contributes a
`@dwk/mcp` tool (`createMicropubMcpTools` → `micropub_publish`) so an authorized
agent can publish through the same `publishPost` path the HTTP `create` action
uses.

## Micropub extensions

Implements a curated subset of the
[IndieWeb Micropub extensions](https://indieweb.org/Micropub-extensions),
toggled by maturity group via the `extensions` config
(`{ official?, stable?, proposed? }`; defaults `official`+`stable` on,
`proposed` off). Currently all **stable**:

- **Post Status** (`post-status`) / **Visibility** (`visibility`) — validated on
  create/update; stored & advertised only. Read-time enforcement (hiding drafts,
  gating private posts) is the serving layer's job, not this package's.
- **Supported Vocabulary** — optional `postTypes` config advertised as
  `post-types` in `q=config`.
- **Category/Tag List** (`q=category`, with `limit`/`filter`) — distinct tags of
  live posts for autocomplete.
- **Post List** (`q=source` with no `url`) — the caller's live posts
  newest-first, with `limit`/`offset` pagination (#351/#353).
- **Richer Post List Filters** — proposed-only `q=source` filters with keyset
  cursors; see the package spec for the wire contract.
- **Location/Venue** (`q=geo`, #359) — proposed-only read-only proximity
  search over an injected `venues` D1 store, independent from post storage.
  `geo`'s reverse-geocoded suggestion is a placeholder (echoes the query
  coordinates) until a real lookup is wired in.
- **Media-endpoint extensions** (#363) — proposed-only media `q=source`
  (listing + by-URL, `media` scope), `{ url }` upload response body, and
  recoverable `action=delete`/`undelete` via an R2 `.trash/` prefix with
  scope-pair enforcement. Upload metadata is always recorded in the
  `micropub_media` D1 table (fail-closed only when the group is on).

## Spec

`spec/packages/micropub.md` — authoritative requirements.

## Key constraints

- **DPoP mandatory on every request.** Bearer-token-only clients (e.g.,
  micropub.rocks default mode) cannot authenticate. Every authenticated request
  must present a valid DPoP proof bound to the access token.
- **Subject (`me`) binding.** The access token's `me` claim must match the
  configured profile URL. Tokens issued for a different identity are rejected.
- **JTI dedup in D1.** DPoP proof `jti` values are stored in D1 (`AUTH_DB`) and
  checked for replay on every request.
- **Media endpoint.** Uploads go to R2 (`MEDIA` bucket). The `media` scope is
  separate from `create` for least privilege.
- **Scope enforcement.** Each operation requires its specific scope; `create`
  does not grant `update` or `delete`.
