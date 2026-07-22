# `@dwk/micropub`

> Micropub create/update/delete endpoint with R2 media endpoint. Consumes IndieAuth tokens.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/micropub.md) for the full requirements.

A [Micropub](https://micropub.spec.indieweb.org/) server that runs as a
Cloudflare Worker. It accepts both JSON and form-encoded requests, authorizes
every request with a DPoP-bound IndieAuth access token (issued by
[`@dwk/indieauth`](../indieauth)), stores published posts as microformats2 source
in D1, and backs its media endpoint with R2.

## Usage

```ts
import { createMicropub, createMicropubContactStore } from "@dwk/micropub";

const micropub = createMicropub({
  baseUrl: "https://example.com",
  // the site owner's IndieAuth profile URL; tokens minted for any other `me`
  // are rejected even if they carry the right scope
  me: "https://example.com/",
  // optional: defaults are `${origin}/micropub` and `${origin}/media`
  micropubEndpoint: "https://example.com/micropub",
  mediaEndpoint: "https://example.com/media",
  syndicateTo: [{ uid: "https://news.example/@me", name: "Example News" }],
  // Proposed extensions stay opt-in. These are metadata for the site's
  // serving/access-control layer; Micropub itself does not enforce them.
  extensions: { proposed: true },
  audiences: [{ uid: "family", name: "Family" }],
  contacts: createMicropubContactStore,
});

export default {
  fetch(request, env, ctx) {
    return micropub(request, env, ctx);
  },
};
```

### Bindings (declared `Env` fragment)

The handler fails loudly at startup if any of these are missing:

- `MEDIA` — R2 bucket backing the media endpoint.
- `MICROPUB_DB` — D1 database holding published post records.
- `AUTH_DB` — the `@dwk/indieauth` issued-token store, consulted for revocation.
- `TOKEN_SIGNING_KEY` — the secret the IndieAuth token endpoint signs tokens with.

### What it implements

- **Create** (`h-entry` etc.) from JSON, form-encoded, and `multipart/form-data`
  bodies — the latter folds uploaded files (e.g. `photo`) into the post.
- **Update** (JSON `replace`/`add`/`delete`), **delete**, and **undelete**
  (soft, reversible).
- **Media endpoint**: streams uploads to R2 and serves them back.
- **Queries**: `q=config`, `q=source` (with a `properties[]` filter), and
  `q=syndicate-to`.
- **Opt-in Contacts** (`q=contact`): a private h-card address book with
  filtered, paginated listing and create/update/delete lifecycle actions.
- **Opt-in proposed metadata**: named private-post `audience` values and
  `location-visibility` (`public`, `private`, or textual-only `text`). They
  are persisted and returned by `q=source`; the site or WAC layer enforces
  access control and redaction.
- **Opt-in source-list filters**: proposed deployments can filter a `q=source`
  list by creation bounds, type, status, visibility, or exact mf2 properties;
  filtered lists use deterministic keyset cursors.

### Location/Venue (`q=geo`) extension

The `q=geo` extension is implemented for the proposed Location/Venue feature.
It remains disabled by default (`extensions.proposed: false`); clients must
enable the `proposed` group and configure a `venues` store to use it.

A `GET ?q=geo&uri=geo:lat,lon;u=radius` or `GET ?q=geo&lat=...&lon=...&u=...` query
returns a reverse-geocoded `geo` suggestion (when available) and nearby venues
ordered by distance. Each venue has `name`, `latitude`, `longitude`, and a
canonical `url`. Clients reference a venue via the post's `location` property
(either plain text or an `h-card` with `url`). The store is independent of
post storage — querying `q=geo` never reads post data.

See the [package specification](../../spec/packages/micropub.md#proposed-locationvenue-qgeo).

Every request is authorized by an IndieAuth access token whose scope gates the
action (`create`, `update`, `delete`, `media`), with the DPoP proof-of-possession
binding completed via [`@dwk/dpop`](../dpop) and revocation checked against the
strongly-consistent token store.

## License

[ISC](../../LICENSE)
