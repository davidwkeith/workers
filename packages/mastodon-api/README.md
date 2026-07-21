# @dwk/mastodon-api

A Mastodon-compatible client API subset for Cloudflare Workers: log in with an
off-the-shelf fediverse client (Pixelfed's app, Tusky, Elk) and browse this
deployment's account — **read-only**. Publishing stays with Micropub/MCP; this
package adds no write path.

## What phase 1 ships

- `POST /api/v1/apps` + `GET /api/v1/apps/verify_credentials` — Mastodon's
  pre-RFC-7591 dynamic app registration, layered on `@dwk/oauth`'s metadata
  validation.
- `GET /oauth/authorize`, `POST /oauth/token` (`authorization_code` +
  `client_credentials`), `POST /oauth/revoke` — the Mastodon app OAuth flow.
  Owner authentication/consent is a config-injected approval hook; the package
  ships no login UI and stores no password.
- `GET /api/v1/instance`, `GET /api/v2/instance` — instance metadata with a
  GoToSocial-style compatibility `version` string.
- `GET /api/v1/accounts/verify_credentials` — the owner account (live counts
  arrive with the phase-2 backend; zeros until then).
- `GET`/`POST /api/v1/markers` — saved read positions, persisted in D1.
- A data-driven roster of valid-but-empty stubs (`filters`, `lists`,
  `custom_emojis`, …) that real clients call at startup.

The read surface (timelines, notifications, statuses) arrives in phase 2 via
the `MastodonBackend` seam, implemented by `@dwk/activitypub`'s
`createActivitypubMastodonApi` adapter.

## Usage

```ts
import { createMastodonApi } from "@dwk/mastodon-api";

const handler = createMastodonApi({
  baseUrl: "https://example.com",
  instance: { title: "My site", contactEmail: "me@example.com" },
  account: { username: "me", displayName: "Me" },
  approveAuthorization: async (request, httpRequest) => {
    // Authenticate the owner and obtain consent (render a page by returning
    // a Response), then:
    return { approved: true };
  },
});

export default {
  fetch: (request: Request, env: { AUTH_DB: D1Database }, ctx: ExecutionContext) =>
    handler(request, env, ctx),
};
```

Bindings: one D1 database, `AUTH_DB` (the shared auth-database binding name;
tables are `mastodon_`-prefixed and coexist with other packages').

## Token model

Access tokens are opaque 256-bit random strings stored as SHA-256 hashes in
D1 — plain `Bearer`, because compatibility with real Mastodon clients is the
point. This is the repo's documented, mitigated exception to the
DPoP-everywhere rule: the surface is read-only, the tokens are accepted by no
other package, and RFC 7009 revocation is the lifecycle. See
`spec/mastodon-client-api.md`.

## Spec

`spec/packages/mastodon-api.md` — authoritative requirements. Design:
`spec/mastodon-client-api.md` (issue #327).
