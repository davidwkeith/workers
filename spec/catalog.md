# Worker catalog (`catalog.json`)

**Status:** provisional (pre-1.0). **Consumer:** composing apps, first
[Anglesite](https://github.com/Anglesite/Anglesite-app)
([Anglesite-app#708](https://github.com/Anglesite/Anglesite-app/issues/708),
design doc
[`2026-07-13-workers-local-debugging-design.md`](https://github.com/Anglesite/Anglesite-app/blob/main/docs/superpowers/specs/2026-07-13-workers-local-debugging-design.md)
§3). **Tracked in:** [#255](https://github.com/davidwkeith/workers/issues/255).

## What it is

[`catalog.json`](../catalog.json) at the repo root is the machine-readable
manifest of every **mountable worker** this monorepo ships. It travels the same
publishing channel as `conformance/status.json`: a composing app fetches the
raw file, caches it, and degrades to its cache when offline. The app uses it
to:

- list workers in a settings UI, grouped, with display name and description;
- decide **activation kind** — component-tied (active iff a bound component is
  used on ≥1 page, computed by the app, never manually toggled) vs
  settings-activated (toggled by the site owner);
- generate wrangler configuration (local `wrangler dev --local` and
  production) for the effective active worker set.

The shape is mirrored by [`catalog.schema.json`](../catalog.schema.json)
(editor tooling / consumer validation) and enforced in CI by
`scripts/catalog-gate.mjs` (`pnpm catalog:check`, unit-tested via
`pnpm test:catalog`).

## Stability contract

- **`id` values are forever-stable.** Composing apps persist activation state
  (`activeWorkerIDs`, `lastDeployedWorkerIDs`) against them. Renaming an id is
  a breaking change even while everything else is provisional.
- Everything else (fields, groups, resource shapes) is **provisional while the
  repo is pre-1.0**, but changes are coordinated as paired-repo changes with
  the consuming app — never silently.
- `group` is a free-text key. Apps section by it and must not hardcode group
  names; this repo may add or rename groups (that is a display change, not a
  breaking one).
- `binding.componentIDs` are identifiers in the consuming app's site/component
  model (Anglesite Site Graph Explorer node IDs). Their values are coordinated
  with the app, not invented here.

## Entry shape

```json
{
  "id": "webmention",
  "package": "@dwk/webmention",
  "displayName": "Webmentions",
  "description": "Receive, verify, and send Webmentions for posts on this site.",
  "group": "social",
  "binding": { "kind": "componentTied", "componentIDs": ["webmention-form"] },
  "resources": [
    { "type": "queue", "binding": "WEBMENTION_QUEUE", "consumer": true },
    { "type": "d1", "binding": "WEBMENTION_INBOX" }
  ],
  "requires": []
}
```

### `resources` — bindings with wrangler-config fidelity

The original Anglesite design sketched `{needsD1, needsKV, needsR2}` booleans;
this repo publishes a typed `resources` array instead (the shape question
flagged in #255), because the app generates real wrangler config from it:

| `type`           | Fields                                        | Generates                                                                                                   |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `d1`             | `binding`                                     | a `d1_databases` entry                                                                                       |
| `kv`             | `binding`                                     | a `kv_namespaces` entry (safe-to-be-stale caches only — never authz state)                                   |
| `r2`             | `binding`                                     | an `r2_buckets` entry                                                                                        |
| `durable-object` | `binding`, `className`, `sqlite`              | a `durable_objects.bindings` entry **plus** a migration listing `className` under `new_sqlite_classes`       |
| `queue`          | `binding`, `consumer`                         | a `queues.producers` entry, plus a `queues.consumers` entry when `consumer` is true                          |
| `secret`         | `binding`                                     | a required `wrangler secret put` (the app should prompt; packages fail loudly at startup if it is missing)   |

Conventions:

- **Shared bindings share names.** Entries that name the same binding (e.g.
  `AUTH_DB` on `indieauth`/`micropub`/`microsub`, or `BLOBS`/`POD` on
  `solid-pod`/`webdav`) refer to the same binding, declared once in the
  composed config. The composer deduplicates by binding name.
- `optional: true` means the worker functions without the binding (a
  degraded/auxiliary path, e.g. the shared `GC_DB` orphan-tracking database).
  Non-optional resources must all be bound — every package fails loudly at
  startup on a missing required binding, per the
  [composition contract](./composition-contract.md).
- Queue **names** (as opposed to binding names), D1 database names/ids, and R2
  bucket names are the composer's choice — the catalog only fixes the env
  binding names the package code reads. See
  `packages/conformance-target/wrangler.jsonc` for a full worked composition.

### `requires`

Catalog ids that must also be active for this worker to function
(`webdav` → `solid-pod`; `micropub`/`microsub` → `indieauth` for the shared
token store). Apps should surface the dependency when toggling.

### `libraries`

Top-level map of every publishable workspace package that is deliberately
**not** a catalog worker (the reusable libs), each with a one-line reason. The
catalog gate enforces exhaustiveness: every publishable package appears either
as a worker entry or under `libraries`, so adding a package forces an explicit
catalog decision.

## Route claims (`routes`, issue #256)

Paired with
[Anglesite-app#746](https://github.com/Anglesite/Anglesite-app/issues/746):
each worker entry may declare the HTTP routes its handler owns, so the
composing app can generate **selective Worker-first routing** — only the
active workers' claimed routes go worker-first (wrangler
`[assets].run_worker_first`); every other path stays asset-first.

```json
{
  "path": "/.well-known/webfinger",
  "match": "exact",
  "methods": ["GET"],
  "head": true,
  "handler": "createWebfinger",
  "authorityBound": true
}
```

- `path` — absolute, no traversal or empty segments.
- `match` — `exact`, or `prefix` **only where the standard delegates a whole
  subtree** (an ActivityPub actor space `/users/`, served media `/media/`),
  never as a convenience. A prefix path ends with `/` and covers the subtree
  under it (not the slash-less path itself).
- `methods` — the allowed methods; the composer answers others with `405` +
  `Allow`. `HEAD` is never listed: `head: true` declares it, mirroring GET's
  headers without a body.
- `handler` — the factory export that owns the claim, so the app can
  correlate a route with the handler that must be mounted.
- `authorityBound` — the standard fixes this path to the site's canonical
  origin (`/.well-known/*` discovery documents); it must not be remounted.

### Route claim fields for Anglesite-app's `WorkerRouteClaim` (issue #746, paired with [Anglesite-app#829](https://github.com/Anglesite/Anglesite-app/pull/829))

Three further fields are optional on every route claim, mirroring Anglesite-app's
`WorkerRouteClaim` (`Sources/AnglesiteCore/WorkerCatalog.swift`, validated by
`Sources/AnglesiteCore/WorkerRouteClaims.swift`). Older consumers ignore
unrecognized JSON keys, so adding them is backward-compatible.

```json
{
  "path": "/.well-known/oauth-authorization-server",
  "match": "exact",
  "methods": ["GET"],
  "handler": "createIndieAuth",
  "validatorID": "rfc8414",
  "authorityBinding": true,
  "specificationURL": "https://www.rfc-editor.org/rfc/rfc8414"
}
```

- `validatorID` — protocol-validator registry reference (#744's registry).
  Omitted means the route is inventory-only: no conformance claim is made
  for it.
- `authorityBinding` — whether responses on this route bind an
  identity/application/policy to the whole origin. Broader than
  `authorityBound`'s fixed well-known paths: a remountable route can still
  be origin-identity-binding (e.g. IndieAuth's `/authorize` and `/token`
  establish the site's IndieAuth identity even though a composer may mount
  them elsewhere). Defaults to `false` when omitted.
- `specificationURL` — the governing protocol specification. Anglesite-app's
  consumer requires this on every `prefix` claim (only a specification can
  approve child paths); recommended on `exact` claims too. Not yet
  back-filled onto this repo's pre-existing `prefix` claims (`/users/`,
  `/nodeinfo/`, `/pod/`, `/dav/`, `/storage/`, `/xrpc/`) — tracked as a
  follow-up rather than bundled into an unrelated change.

**Mount-prefix contract.** The composition contract lets a composer mount any
handler under an arbitrary path prefix. Route claims are static data, so they
declare each package's **canonical/default mount paths** — the paths the
conformance target (`packages/conformance-target/src/mounts.ts`) composes and
the specs assume. A composer that remounts a handler under a different prefix
takes over rewriting that worker's claims to match; `authorityBound` claims
are the exception and must never be remounted.

**Overlap rule.** Claims from _different_ workers must never overlap (equal
exact paths, an exact path under another's prefix, or nested prefixes) — the
composing app resolves each request to exactly one active worker, and the
catalog gate enforces this. Claims _within_ one worker may overlap; its
handler does its own sub-routing.

**IndieAuth's claims verified against `@dwk/indieauth`'s handler (issue #829
follow-up).** `createIndieAuth` (`packages/indieauth/src/handler.ts`) rejects
any method other than `GET` on the metadata endpoint (no `HEAD` support,
unlike `webfinger`/`host-meta`), accepts only `POST` on `/token` (not `GET`),
and returns `404` for any pathname it doesn't route by exact match — consent
is a config-injected hook invoked from inside `/authorize`, not a separate
HTTP route, so there is no `/indieauth/consent` claim to make.

Populated for the 8 packages Anglesite composes today (`indieauth`,
`micropub`, `microsub`, `webmention`, `websub`, `activitypub`, `webfinger`,
`host-meta`) plus the storage/identity workers (issue #264, follow-up to
#256/#260): `solid-pod` (`/pod`, `/pod/`), `webdav` (`/dav`, `/dav/` for the
data door; `/dav-credentials` for the app-password admin endpoint — both
wired through `@dwk/solid-pod`'s `createSolidPodWebdav`/
`createSolidPodWebdavCredentials`, the actual composed handlers, not
`@dwk/webdav`'s bare `createWebdav`), `remotestorage` (`/storage/`),
`atproto-pds` (`/xrpc/`, plus the authority-bound `/.well-known/atproto-did`
and `/.well-known/did.json`), and `webauthn` (the four ceremony endpoints
under `/webauthn/`).

**The `vc`/`atproto-pds` `/.well-known/did.json` collision (resolved).**
`@dwk/vc`'s handler never serves `/.well-known/did.json` — per its spec, the
`did:web` DID document is a static artifact the composer (Anglesite)
generates, outside this Worker's routes entirely; `createVc` only mounts the
dynamic issue/verify/status endpoints. So `vc` has no route claim to make
here and nothing collides: `atproto-pds` is the only package whose *handler*
serves `/.well-known/did.json` (for its own `did:web` accounts), and it
claims that path as `authorityBound`. A composer running both `vc` and
`atproto-pds`'s `did:web` mode on one domain must still keep their DID
identities distinct at the static layer (e.g. `vc`'s issuer as a path-based
`did:web:<host>:credentials` document at `/credentials/did.json`) — that
static-generation decision belongs to the composer, not this catalog.

## Scheduled triggers (`triggers`, issue #265)

Each worker entry may declare the background jobs the composed Worker must run
on a schedule whenever the worker is active — **independent of HTTP routing**:
a `scheduled` event is never request-triggered, so trigger claims apply
regardless of any route claims. Each claim generates a wrangler
`triggers.crons` entry plus a `scheduled()` export wired to the named
factory's handler (see the conformance target's `scheduled` export for a
worked composition).

```json
{
  "cron": "*/15 * * * *",
  "handler": "createSolidPodGc",
  "bindings": ["BLOBS", "GC_DB"],
  "dedupe": "store-gc",
  "description": "Reclaims orphaned R2 blobs the pod forwards into the shared GC_DB tracking database."
}
```

- `cron` — the canonical five-field cron expression. A default cadence, not a
  protocol requirement; composers may tune it.
- `handler` — the factory export producing the `scheduled` handler, so the
  app can correlate the trigger with the code it must wire (mirrors the
  `handler` field on route claims).
- `bindings` — binding names from this worker's own `resources` the handler
  reads. When a listed binding is **optional and left unbound**, the composer
  omits the trigger instead of binding it (the handlers fail loudly without
  their bindings) — this is how "GC needs a cron when `GC_DB` is bound"
  is expressed.
- `dedupe` — shared-job key. Triggers on different active workers carrying
  the same key are **one underlying job**: `solid-pod` and `remotestorage`
  share the `@dwk/store` GC schema over one `BLOBS`/`GC_DB` pair, so one
  collector pass covers both. The composer emits one cron entry and wires any
  one of the declared handlers. Equal keys must declare equal cron
  expressions — the catalog gate enforces this.
- `description` — human-readable purpose, for composing-app UI.

Populated for `solid-pod` (`createSolidPodGc`) and `remotestorage`
(`createRemoteStorageGc`), the two workers whose orphan-tracking GC needs a
cron when `GC_DB` is bound.

## What the catalog does not cover (yet)

- **Config-object requirements** — factory config (base URL, issuer, origins)
  is code-level and documented per package in `spec/packages/`; the catalog
  only describes Cloudflare bindings.
