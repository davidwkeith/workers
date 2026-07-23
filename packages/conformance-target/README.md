# @dwk/conformance-target

The deployed conformance target for the `@dwk/workers` monorepo: every
endpoint package composed into one Worker behind `https://conformance.dwk.io`,
per `spec/composition-contract.md`. The hosted conformance suites
(micropub.rocks, webmention.rocks, the Solid harness, litmus) run against it;
`conformance/status.json` records the results. **Private — never published.**
It doubles as the reference for "how do I compose these packages into one
Worker".

## Mount table

| Path                                                                             | Package                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/.well-known/webfinger`                                                         | `@dwk/webfinger`                                               |
| `/.well-known/host-meta[.json]`                                                  | `@dwk/host-meta`                                               |
| `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/revocation` | `@dwk/indieauth`                                               |
| `/micropub`, `/media/*`                                                          | `@dwk/micropub`                                                |
| `/microsub`                                                                      | `@dwk/microsub`                                                |
| `/webmention`                                                                    | `@dwk/webmention`                                              |
| `/webmention/send`                                                               | webmention sender trigger (owner-gated, see below)              |
| `/websub`                                                                        | `@dwk/websub`                                                  |
| `/users/conformance*`, `/inbox`, `/.well-known/nodeinfo`, `/nodeinfo/*`          | `@dwk/activitypub`                                             |
| `/storage/<account>/*`                                                           | `@dwk/remotestorage`                                           |
| `/pod/*`                                                                         | `@dwk/solid-pod` (LDP door)                                    |
| `/dav/*`                                                                         | `@dwk/solid-pod` WebDAV door — **its own pod** (litmus target) |
| `/dav-credentials`                                                               | app-password mint/list/revoke (owner-gated)                    |
| `/webauthn/*`                                                                    | `@dwk/webauthn`                                                |
| `/credentials/*`                                                                 | `@dwk/vc`                                                      |
| `/xrpc/*`, `/.well-known/atproto-did`, `/.well-known/did.json`                   | `@dwk/atproto-pds`                                             |
| `/admin/init`                                                                    | one-time D1 schema init (owner-gated)                          |
| `/`, `/profile/card`                                                             | test identity (h-card + WebID)                                 |

The `/dav` pod is deliberately separate from `/pod`: the per-pod Durable
Object is keyed by the configured `baseUrl`, so mounting both doors on one pod
requires verb-based dispatch — deferred until the Solid conformance phase.

Owner authentication is an interim shared-secret bearer
(`Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN`) that resolves to the owner
WebID `https://conformance.dwk.io/profile/card#me`. It is replaced by real
Solid-OIDC in the Solid harness phase.

## One-time setup

Prereqs: the `dwk.io` zone on the Cloudflare account; `wrangler` authenticated
(`wrangler login` locally, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
in CI). All commands run from `packages/conformance-target/`.

1. Create the R2 buckets and D1 databases:

   ```bash
   wrangler r2 bucket create dwk-conformance-blobs
   wrangler r2 bucket create dwk-conformance-media
   for db in auth micropub microsub websub webmention gc; do
     wrangler d1 create "dwk-conformance-$db"
   done
   ```

   Paste each printed `database_id` into `wrangler.jsonc` (replacing the
   `REPLACE-AFTER-d1-create` placeholders) and commit.

2. Create the queues:

   ```bash
   wrangler queues create conformance-webmention
   wrangler queues create conformance-websub
   wrangler queues create conformance-microsub
   ```

3. Set the secrets. **Do not paste values into the interactive `wrangler
   secret put NAME` prompt** — in most terminals a multi-line paste (the
   PEMs, the JWK) submits after the first line and the rest gets typed at
   your shell as commands. Instead, generate each value into a file (or an
   env var) and redirect it into wrangler's stdin, which it reads
   non-interactively:

   ```bash
   # Simple random secrets: write to a var, pipe with printf (no trailing
   # newline in the secret value).
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put TOKEN_SIGNING_KEY
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put CONFORMANCE_PASSWORD
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put CONFORMANCE_ADMIN_TOKEN
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put ATPROTO_PASSWORD
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put ATPROTO_JWT_SECRET

   # RSA keypair for the ActivityPub actor — written straight to files, then
   # piped in with `<` so the multi-line PEM never touches the prompt:
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ap.pem
   openssl pkey -in ap.pem -pubout -out ap.pub.pem
   wrangler secret put ACTIVITYPUB_PUBLIC_KEY_PEM < ap.pub.pem
   wrangler secret put ACTIVITYPUB_PRIVATE_KEY_PEM < ap.pem
   rm ap.pem ap.pub.pem

   # Optional: enables the owner publish endpoints (POST <actor>/outbox and
   # /publish) that the fedify suite's fanout/announce-unwrap cases drive;
   # mirror the same value into the FEDIFY_PUBLISH_TOKEN repo secret.
   openssl rand -base64 32 | tr -d '\n' | wrangler secret put ACTIVITYPUB_PUBLISH_TOKEN

   # P-256 private JWK for the VC issuer — write to a file first, same reason:
   node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))" > vc.jwk
   wrangler secret put VC_SIGNING_KEY < vc.jwk
   rm vc.jwk
   ```

   If you already hit the interactive-paste problem and a secret looks
   truncated or your shell ran stray commands, check what actually got set
   and redo it with the `<` form above:

   ```bash
   wrangler secret list
   wrangler secret delete ACTIVITYPUB_PUBLIC_KEY_PEM   # then re-run with < ap.pub.pem
   ```

4. In the GitHub repo, add the `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit,
   Workers Routes:Edit, D1:Edit, Queues:Edit, R2:Edit) and
   `CLOUDFLARE_ACCOUNT_ID` secrets for the CI deploy job — plus, optionally,
   `FEDIFY_PUBLISH_TOKEN` (the same value as `ACTIVITYPUB_PUBLISH_TOKEN`
   above) so the hosted fedify suite can run its fanout and announce-unwrap
   cases.

5. _(Optional)_ Enable
   [Onion Routing](https://developers.cloudflare.com/network/onion-routing/)
   on the zone so Tor Browser users reach the target over Tor instead of an
   exit node. It is transparent to the Worker (Host/SNI preserved) and needs
   no config change here — dashboard **Network → Onion Routing**, or:

   ```bash
   curl -X PATCH \
     "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/opportunistic_onion" \
     -H "Authorization: Bearer $API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"value":"on"}'
   ```

## Deploy

From the repo root (dependencies must be built first — wrangler bundles the
workspace packages from their `dist/`):

```bash
pnpm build
pnpm --filter @dwk/conformance-target deploy
```

Or trigger the `Conformance` workflow's deploy job (`workflow_dispatch`).

### Initialize the D1 schemas

A freshly created D1 database has no tables — the IndieAuth consent flow (and
anything depending on it) 500s until the schemas exist. After every deploy of
a fresh database (first deploy, or after a reset — see below), initialize
them once via the admin-gated route:

```bash
curl -X POST https://conformance.dwk.io/admin/init \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN"
```

This calls each mounted package's public D1-store init API
(`@dwk/indieauth`, `@dwk/micropub`, `@dwk/microsub`) and is idempotent —
safe to rerun. `@dwk/websub` and `@dwk/webmention` create their schema lazily
on first use and have no public init API to call, so the response lists them
as `"unavailable"` rather than reaching into their internals. Run this
**before** any suite run below.

## Running webmention.rocks/sender

`@dwk/webmention` ships a `sendWebmention`/`sendWebmentions` sender library,
but nothing on this deployment called it until `POST /webmention/send` was
added (issue #405) — without a trigger, the sender half of
[webmention.rocks](https://webmention.rocks/) has nothing to drive. See
`conformance/webmention-qa.md` for the full runbook; the trigger itself:

```bash
curl -sS -X POST https://conformance.dwk.io/webmention/send \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"<webmention.rocks source-page URL>","target":"<webmention.rocks target URL>"}'
```

Response is the library's `SendResult` as JSON (`{target, endpoint,
delivered, status}`). webmention.rocks/sender hands you a source-page URL per
discovery edge case and a target to notify — pass those straight through; the
`source` need not be a page this deployment actually published, since the
suite is testing discovery + notification, not authorship.

## Running litmus (WebDAV conformance)

1. Mint a read-write app password:

   ```bash
   curl -sS -X POST https://conformance.dwk.io/dav-credentials \
     -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"label":"litmus","scope":{"modes":["read","write"]}}'
   ```

   The response contains `username` and `secret` (shown once).

2. Seed the pod: it is lazily materialized, so an empty pod's root 404s even
   for the owner — PROPFIND on `/dav/` will fail until at least one resource
   exists. Write one before running the suite:

   ```bash
   curl -sS -X PUT https://conformance.dwk.io/dav/seed.txt \
     -u "<username>:<secret>" \
     -H "Content-Type: text/plain" \
     -d seed
   ```

3. Run the suite through the dispatcher (litmus must be installed —
   `apt-get install litmus` / `brew install litmus`):

   ```bash
   node scripts/conformance/run-suite.mjs webdav \
     --target https://conformance.dwk.io/dav/ \
     --username <username> --password <secret>
   ```

4. On green, record the result in `conformance/status.json`
   (`@dwk/webdav` → suites → litmus → `"passing"`, with the run date), and
   revoke the credential:

   ```bash
   curl -sS -X DELETE "https://conformance.dwk.io/dav-credentials?id=<credentialId>" \
     -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN"
   ```

## Resetting suite data

Suite runs accumulate state in the DOs / R2 / D1 of this deployment. To reset:
delete and recreate the D1 databases and R2 buckets (step 1 above), then
redeploy — DO storage for `new_sqlite_classes` is dropped with
`wrangler delete` + redeploy. Re-run `POST /admin/init` before the next suite
run. Never point suites at a production identity.
