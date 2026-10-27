# IT guide: running `@dwk` workers on your Cloudflare account

For the IT person at a small business or non-profit who inherited a site built
on `@dwk` packages (often via [Anglesite](https://anglesite.app)) and needs to
know what is running, where the data lives, and how to debug it. No TypeScript
required; you will need dashboard access to the Cloudflare account and,
ideally, [Wrangler](https://developers.cloudflare.com/workers/wrangler/) on a
laptop.

Developers wanting the design rationale should read
[`spec/architecture.md`](../spec/architecture.md) and
[`spec/composition-contract.md`](../spec/composition-contract.md) instead.

## 1. What is running

Everything runs on **your** Cloudflare account. There is no vendor server, no
license check, and nothing phones home. If your Cloudflare account is healthy,
the site is healthy.

```
 visitor / app / other server
            │  HTTPS
            ▼
 ┌─────────────────────────────┐   Cloudflare zone settings apply here first:
 │  Your zone (example.org)    │   WAF, Bot Fight Mode, cache rules, Access,
 └──────────────┬──────────────┘   Rocket Loader, redirects …
                ▼
 ┌─────────────────────────────┐
 │  One Worker (the "front     │   Stateless. Routes by path to each package,
 │  door")                     │   checks tokens, rejects bad input.
 └───┬──────────┬──────────┬───┘
     ▼          ▼          ▼
  Durable     D1 (SQL)    R2 (files)      + Queues (background jobs)
  Objects                                 + Cron Trigger (scheduled cleanup)
  (per-pod /
  per-actor state)
```

- **One Worker, one domain.** Each feature (IndieAuth sign-in, Micropub
  posting, Fediverse, Solid Pod, …) is a separate npm package, but they are
  all compiled into a single Worker and routed by URL path. One bad package
  can return errors on its paths without the others going down — but they
  share one deploy, one log stream, and one set of
  [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
- **The Worker holds no state.** All data is in the storage products below.
  Redeploying or rolling back the Worker never loses data.
- **Each package is configured in code, not in the dashboard.** Base URL,
  allowed origins, and similar settings are compiled in by whoever built the
  site. Changing them means a redeploy, not a dashboard toggle.

### Where the data lives

| Cloudflare product                                                                      | Used for                                                                                                                 | Packages                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) (SQLite)          | Authoritative per-owner state: pod contents index, Fediverse followers and outbox, passkeys, remoteStorage, Bluesky repo | `solid-pod`, `webdav`, `activitypub`, `mastodon-api`, `remotestorage`, `webauthn`, `atproto-pds`                                |
| [D1](https://developers.cloudflare.com/d1/)                                             | Tokens and auth codes, posts, feed subscriptions, webmention inbox, WebSub subscribers, blob GC bookkeeping              | `indieauth`, `solid-oidc`, `micropub`, `microsub`, `webmention`, `websub`, `vc`, `solid-pod`/`remotestorage` (optional `GC_DB`) |
| [R2](https://developers.cloudflare.com/r2/)                                             | File bodies: uploaded media, pod files, Bluesky blobs                                                                    | `micropub` (`MEDIA`), `solid-pod`/`webdav`/`remotestorage`/`atproto-pds` (`BLOBS`)                                              |
| [Queues](https://developers.cloudflare.com/queues/)                                     | Background work: verifying webmentions, delivering WebSub updates, polling feeds                                         | `webmention`, `websub`, `microsub`                                                                                              |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Periodic orphaned-blob cleanup; feed polling                                                                             | `solid-pod`/`remotestorage` GC, `microsub`                                                                                      |
| [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)             | Signing keys (`TOKEN_SIGNING_KEY`, `OIDC_SIGNING_KEY`, `VC_SIGNING_KEY`, `WEBDAV_PEPPER`, ActivityPub keys)              | see [`catalog.json`](../catalog.json)                                                                                           |

**KV is never used for anything security-relevant** — it is eventually
consistent (~60 s), so a revoked token or changed permission could linger
([rule](../spec/non-functional-requirements.md#consistency-rules-load-bearing)).
If you see KV in your config, it is a cache that is safe to wipe.

The exact binding names each feature needs are in
[`catalog.json`](../catalog.json) under `resources`, and in each package's
spec under [`spec/packages/`](../spec/packages/). A working example of every
package wired together is
[`packages/conformance-target/wrangler.jsonc`](../packages/conformance-target/wrangler.jsonc).

### Binding names matter

A _binding_ is the name the Worker uses to reach a resource (e.g. `AUTH_DB` →
a D1 database called `myorg-auth`). The **binding name is fixed by the
package**; the underlying database/bucket name is yours to choose. Packages
that share a binding name (`AUTH_DB` for `indieauth`, `solid-oidc`,
`micropub`, `microsub`, `mastodon-api`; `BLOBS` for the storage packages;
`ACTOR` for `activitypub` + `mastodon-api`) are meant to share **the same**
resource — pointing them at different databases splits your users' tokens or
files in two.

## 2. Everyday operations

### Watch logs live

```sh
npx wrangler tail <worker-name> --format pretty
# only errors:
npx wrangler tail <worker-name> --status error
```

Or in the dashboard: **Workers & Pages → your Worker → Logs**. Enable
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
(`"observability": { "enabled": true }` in the Wrangler config) to keep
history and search it; `wrangler tail`
([real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/))
only shows what happens while you watch.

Packages log **only if** the site's developer wired a logger in (see
[`spec/observability.md`](../spec/observability.md)). If the logs show
requests but no `@dwk` events, ask them to pass `consoleLogger` from
[`@dwk/log`](../packages/log) into each package. Some background work (the
Fediverse delivery queue) logs to the console regardless.

### Reading the events

Every event has a stable dotted name, `<package>.<area>.<outcome>`, plus
fields like `reason`, `host`, and `status`. Search logs by event name, not
prose. **Tokens, cookies, and full URLs are never logged** — URLs appear as
host only — so logs are safe to share with a contractor.

| Event pattern                                                                   | What it means                                                                                                                                                     | Usually                                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `*.ssrf.blocked`, `activitypub.delivery.blocked`                                | The site refused to fetch a URL that points at a private or internal address (`reason`: `blocked_host`, `disallowed_scheme`, `invalid_url`, `too_many_redirects`) | Someone probing you. Normal on the public internet; no action needed. A `.onion` host also lands here by design. |
| `*.auth.rejected`, `indieauth.token.rejected`, `solid_oidc.token.dpop_rejected` | A token or proof was refused                                                                                                                                      | Expired/revoked token, or a clock/URL mismatch — see [§3](#dpop-htu_mismatch-or-iat-errors)                      |
| `solid.wac.denied`, `remotestorage.scope.denied`                                | Valid login, but no permission for that resource                                                                                                                  | Check the pod's access-control (`.acl`) files or the app's granted scope                                         |
| `*.queue.retry`, `*.verify.fetch_failed`, `activitypub.delivery.failed`         | A background job will be retried                                                                                                                                  | The remote site is down; Queues and the delivery DO back off automatically                                       |
| `webauthn.config.registration_unguarded`                                        | Anyone can register a passkey                                                                                                                                     | Configuration issue — tell the developer                                                                         |
| `*.error.unhandled`                                                             | A bug                                                                                                                                                             | Collect the timestamp and event, file an issue                                                                   |

Each package's full event list is exported from its `src/log.ts`, e.g.
[`packages/webmention/src/log.ts`](../packages/webmention/src/log.ts).

### Charts instead of log lines

If the developer wired `analyticsEngineMetrics` from `@dwk/log`, the same
events are counted in
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/).
Query it with SQL — `index1` is the event name — to chart "SSRF blocks per
hour" or "failed deliveries by host". Field layout:
[`spec/observability.md` § Analytics Engine field mapping](../spec/observability.md#analytics-engine-field-mapping).

### Rotating a secret

```sh
npx wrangler secret put TOKEN_SIGNING_KEY
```

Rotating a **signing key** invalidates everything signed with the old one:
rotating `TOKEN_SIGNING_KEY` signs everyone out of IndieAuth/Micropub apps;
rotating ActivityPub keys can make other Fediverse servers reject your posts
until they refetch your key. Schedule it, and tell users to sign in again.

### Backups

- **D1**: [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
  restores to any minute in the last 30 days (7 on the Free plan); also
  `npx wrangler d1 export <db> --remote --output backup.sql`.
- **R2**: no built-in point-in-time restore — copy the bucket on a schedule
  (e.g. with `rclone`, which speaks the
  [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)).
- **Durable Objects**: SQLite-backed objects keep
  [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/storage-api/#pitr-point-in-time-recovery-api)
  for 30 days, but it has to be invoked from code — ask the developer before
  you need it.
- **Secrets** cannot be read back from Cloudflare. Keep signing keys in your
  password manager.

Moving off Cloudflare to your own server later is supported:
[`@dwk/server`](../packages/server/README.md) runs the same packages and has a
data-migration path.

## 3. Debugging by symptom

Start with `wrangler tail` open, reproduce the problem, and read the first
error. Most problems are one of the cases below.

### Every request returns 500, or one feature returns 500 on every request

Look for a log line like:

```
@dwk/micropub: missing required D1 binding `MICROPUB_DB`
```

Packages **fail loudly** when a binding is missing instead of half-working.
Fix: add the binding in the Wrangler config (or **Settings → Bindings** in the
dashboard) with exactly the name in the message, then redeploy. Binding names
are case-sensitive. Find what each package needs in
[`catalog.json`](../catalog.json).

D1 tables are created automatically on first use; you do **not** need to run
SQL migrations by hand.

### Deploy fails mentioning a Durable Object class

Durable Objects need a one-time
[migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
entry declaring the class as SQLite-backed (`new_sqlite_classes`). The class
names are `SolidPodObject`, `ActivityPubObject`, `RemoteStorageObject`,
`WebAuthnObject`, `AtprotoRepoObject` — see the
[reference config](../packages/conformance-target/wrangler.jsonc). Never
delete or rename a class in a migration once it has data: Cloudflare deletes
that object's storage.

### Posts from Fediverse servers, webmentions, or app sign-ins fail (403 / challenge page)

These are **server-to-server or app-to-server** requests, not browsers. They
cannot solve a CAPTCHA or JavaScript challenge. Common culprits on the zone:

- [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
  — cannot be bypassed per path; turn it off if you run the Fediverse,
  Webmention, WebSub, or Micropub features.
- [WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/) or
  managed challenges — add a
  [skip rule](https://developers.cloudflare.com/waf/custom-rules/skip/) for the
  worker's paths (`/.well-known/*`, `/micropub`, `/webmention`, `/websub`,
  `/inbox`, `/users/`, `/nodeinfo/`, `/xrpc/`, `/storage/`, `/pod`, `/dav`).
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  in front of the whole domain — public protocol endpoints must stay public.
  Restrict admin pages only.
- Country or ASN blocks — Fediverse servers are worldwide.

Check **Security → Events** in the dashboard for the request; if it is there,
the zone blocked it before the Worker ever ran.

### Discovery or sign-in breaks after "optimizing" the site

`@dwk` reads and serves exact HTML and JSON. Zone features that rewrite
responses break it:

- [Rocket Loader](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/)
  and [Email Address Obfuscation](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/)
  alter HTML, which can hide the `rel="me"`, `rel="authorization_endpoint"`,
  and microformats markup other sites read.
- **Cache rules** that cache `/.well-known/*`, `/micropub`, `/api/*`, or
  anything with an `Authorization` header will serve one user's answer to
  another or keep stale discovery documents. Bypass cache for the Worker's
  routes.
- Redirect rules that change the host (`www.` ↔ apex) or path: identity is
  tied to **one canonical origin**. Pick one, and make the Worker's configured
  base URL match it exactly.

### DPoP `htu_mismatch` or `iat` errors

Apps prove possession of their token by signing the exact method and URL of
each request ([DPoP](../spec/packages/dpop.md)).

- `htu_mismatch` — the URL the app signed is not the URL the Worker saw. Cause
  is almost always a redirect, a `www.`/apex mismatch, `http://` vs
  `https://` (turn on
  [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)),
  or the site being reached via `*.workers.dev` instead of the custom domain.
- `proof_expired` / `proof_future` / `iat_invalid` — the client's clock is off
  by more than 5 minutes. Fix the client device's time.

### It works on `*.workers.dev` but not on the real domain (or vice versa)

Identity URLs (IndieAuth issuer, WebID, ActivityPub actor, `did:web`) are
built from the base URL compiled into the Worker. Serve the Worker on that
exact domain using a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
or route, and don't advertise the `workers.dev` address to users. Changing
the domain later changes everyone's identity — Fediverse followers in
particular do not follow a domain move automatically.

### Background work isn't happening (webmentions not verified, feeds not updating, Fediverse posts not arriving)

1. **Queues**: in the dashboard, **Storage & Databases → Queues** — is the
   backlog growing? Each producer binding (`WEBMENTION_QUEUE`, `WEBSUB_QUEUE`,
   `MICROSUB_QUEUE`) needs a matching **consumer** pointing at this Worker, or
   messages pile up forever. Consider a
   [dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
   so poison messages don't loop.
2. **Cron**: is a Cron Trigger set on the Worker? Without one, feed polling
   and blob cleanup never run.
3. **Fediverse delivery** runs inside the `ACTOR` Durable Object on a retry
   schedule, not a queue. Look for `activitypub.delivery.failed` with the
   remote `host`; persistent failures to one host usually mean that server is
   down or blocking you.

### Storage bill growing / uploads failing

- Uploads over the Worker's memory budget are streamed to R2, never buffered;
  a failure on a large file is usually a zone **upload size limit**
  ([by plan](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)).
- Deleted files are removed from R2 by the periodic garbage collector, which
  needs both `GC_DB` and a Cron Trigger. Without them orphaned blobs
  accumulate.

### Errors right after a Cloudflare runtime change

The Wrangler config's `compatibility_date` pins runtime behaviour. Keep it
current
([guidance](https://developers.cloudflare.com/workers/configuration/compatibility-dates/))
but bump it deliberately, in a deploy of its own, so a regression is easy to
roll back:

```sh
npx wrangler deployments list
npx wrangler rollback
```

Rollback reverts **code only**; it never reverts data in D1, R2, or Durable
Objects.

## 4. Getting help

When filing an issue at
[github.com/davidwkeith/workers/issues](https://github.com/davidwkeith/workers/issues),
include: the package and version (from `package.json`), the event names and
fields from the log (they are already redacted), the time in UTC, and your
Wrangler config **with database IDs and account IDs removed**. Never paste a
secret or an `Authorization` header. Security problems go through
[private vulnerability reporting](https://github.com/davidwkeith/workers/security/advisories/new)
(see [`.github/SECURITY.md`](../.github/SECURITY.md)), never a public issue.
