# `@dwk/safe-fetch` extraction — design

Tracks [#216](https://github.com/davidwkeith/workers/issues/216) and folds in
[#215](https://github.com/davidwkeith/workers/issues/215).

## Problem

The hardened outbound-fetch primitives (SSRF-safe fetch, capped body read)
exist in the repo four times, as near-copies: `packages/webmention/src/safe-fetch.ts`,
`packages/websub/src/safe-fetch.ts`, `packages/microsub/src/safe-fetch.ts`, and
`packages/vc/src/safe-fetch.ts` (an interim copy added in #232 for #214). A
diff of the four shows they differ only in doc-comment wording, which
log-event name they report under, and two small behavioral deltas:

- `websub`'s copy combines the caller's own `AbortSignal` with the timeout via
  `AbortSignal.any` so a worker-shutdown abort still propagates; the other
  three don't.
- `websub`'s copy strips an extra header (`x-hub-signature`) on a cross-origin
  redirect hop, on top of the shared credential-header set.

Separately, #215 flags four infrastructure fetches with no timeout at all:
`@dwk/vc`'s `did-web.ts:250` (did:web DID document resolution — this one also
has **no SSRF host-block whatsoever**, since it predates the vc-local
safe-fetch copy added for #214's *status-list* fetch specifically) and
`@dwk/atproto-pds`'s `plc-directory.ts` (3 call sites) and `resolve.ts:50`.

## Goal

Promote the hardened primitives into one new cross-standard reusable lib,
`@dwk/safe-fetch`, migrate all four existing consumers onto it (deleting the
duplicated code), and route the four #215 call sites through it too — so
every future package gets the safe default instead of re-deriving it.

## Package: `@dwk/safe-fetch`

New package at `packages/safe-fetch/`, same tier and shape as `@dwk/dpop` /
`@dwk/rdf`: pure, Node-testable, no Cloudflare bindings, `"type": "module"`,
`"sideEffects": false`, ESM `exports` map, ships `dist` + `src` (minus tests).
Depends only on `@dwk/log` (for the injectable `Logger`/`Metrics` types and
no-op defaults, same pattern the four existing copies already use).

### Files

- `src/safe-fetch.ts` — `SsrfError`, `SsrfReason`, `FetchLike`,
  `isPrivateOrReservedHost`, `assertPublicUrl`, `safeFetch`, `safeFetchJson`,
  `SafeFetchOptions`, `SafeFetchResult`. Body is promoted verbatim from
  `webmention/src/safe-fetch.ts` (the most complete copy — full IPv4/IPv6
  parsing including embedded-IPv4 forms and the TEST-NET/CGNAT/benchmark/
  documentation ranges), generalized per the API changes below.
- `src/body.ts` — `readBodyCapped`, `MAX_BODY_BYTES` default, promoted from
  `webmention/src/fetch.ts`.
- `src/index.ts` — re-exports both, with the package doc comment (role, pure/
  protocol-agnostic, `@see spec/packages/safe-fetch.md` — a new spec file
  gets added alongside, mirroring every other package's layout).

### API changes vs. the existing copies

1. **`assertPublicUrl(rawUrl, options?)`** merges `assertPublicUrl` (http+https,
   used by webmention/websub/microsub) and `assertPublicHttpsUrl` (https-only,
   used by vc) into one function:
   ```ts
   function assertPublicUrl(
     rawUrl: string,
     options?: { allowedSchemes?: readonly string[] }, // default ["http:", "https:"]
   ): URL
   ```
   `vc` passes `{ allowedSchemes: ["https:"] }` to keep its existing https-only
   behavior.

2. **`SafeFetchOptions` gains two fields:**
   - `logEvent?: string` — replaces each package's hardcoded import of its own
     log-event enum (`WebmentionLogEvent.SsrfBlocked`,
     `WebSubLogEvent.SsrfBlocked`, etc.). The lib logs/counts under whatever
     string the caller passes, so it stays free of any package's vocabulary.
     Callers keep passing their existing enum *value* — only the import site
     moves, log output is unchanged.
   - `stripHeadersCrossOrigin?: readonly string[]` — additional header names
     to strip on a cross-origin redirect hop, beyond the base credential set
     (`authorization`, `cookie`, `cookie2`, `proxy-authorization`,
     `set-cookie`). `websub` passes `["x-hub-signature"]`.

3. **Caller-signal combining becomes the universal default** (websub's
   behavior): `safeFetch` combines `init.signal` (if given) with its own
   `AbortSignal.timeout` via `AbortSignal.any`. Adopting this everywhere is
   safe — webmention and microsub never pass a signal today, so this is a
   no-op for them; only websub currently exercises the combined path.

4. **New `safeFetchJson`** — generalizes vc's convenience wrapper:
   ```ts
   function safeFetchJson(
     doFetch: FetchLike,
     rawUrl: string,
     init?: RequestInit,
     options?: SafeFetchOptions & { maxBodyBytes?: number },
   ): Promise<unknown>
   ```
   Calls `safeFetch`, checks `response.ok`, reads the body via
   `readBodyCapped(response, maxBodyBytes)`, `JSON.parse`s it. Throws a plain
   `Error` for a non-ok response, an oversized body, or invalid JSON;
   `SsrfError` propagates from the underlying `safeFetch` call. Note the
   signature takes `doFetch` as a required first argument (matching
   `safeFetch` and the webmention/websub/microsub convention) rather than
   vc's current `options.fetch` — vc's call site adjusts accordingly.

### Unchanged

- `isPrivateOrReservedHost`, IPv4/IPv6 parsing, and the private/reserved range
  tables are promoted byte-for-byte from webmention's copy — no behavior
  change.
- `SsrfError`/`SsrfReason` shape is unchanged.
- Manual redirect following, per-hop re-validation, and the redirect-hop cap
  (`DEFAULT_MAX_REDIRECTS = 5`) are unchanged.
- `DEFAULT_TIMEOUT_MS = 10_000` is unchanged.

## Migration (delete the duplicated code, don't just add the new lib)

| Package | Change |
|---|---|
| `@dwk/webmention` | Delete `src/safe-fetch.ts` and `src/fetch.ts`; call sites import `safeFetch`, `readBodyCapped`, `FetchLike`, `SsrfError` etc. directly from `@dwk/safe-fetch`, passing `logEvent: WebmentionLogEvent.SsrfBlocked`. `MAX_BODY_BYTES` (2 MB) stays a webmention-local constant passed explicitly as `maxBodyBytes`. |
| `@dwk/websub` | Same deletion; passes `stripHeadersCrossOrigin: ["x-hub-signature"]` and `logEvent: WebSubLogEvent.SsrfBlocked`. Its own `MAX_BODY_BYTES` (4 MB) stays local, passed explicitly. |
| `@dwk/microsub` | Same deletion; `logEvent: MicrosubLogEvent.SsrfBlocked`. |
| `@dwk/vc` | Delete the interim `src/safe-fetch.ts` from #232. `handler.ts`'s status-list fetch calls the shared `safeFetchJson` with `allowedSchemes: ["https:"]`, `maxBodyBytes: 1_048_576`, `logEvent: "vc.ssrf.blocked"`. `did-web.ts`'s `createDidWebResolver` (see #215 below) gets the same treatment. |
| `@dwk/atproto-pds` | No prior safe-fetch copy; net-new usage (see #215 below). |

Each migrated package adds `"@dwk/safe-fetch": "workspace:*"` to its
`package.json` dependencies.

## Folding in #215

Each of these currently has no SSRF protection and (except the vc status-list
path already fixed in #232) no timeout either:

- **`packages/vc/src/did-web.ts:250`** (`createDidWebResolver`) — today this
  path has *zero* guardrails (it predates #214/#232, which only hardened the
  separate status-list fetch). It fetches an externally-resolved `did:web`
  host during credential verification, so it gets full `safeFetch` treatment:
  `allowedSchemes: ["https:"]`, default timeout/redirect caps,
  `logEvent: "vc.ssrf.blocked"`. `did-web.ts`'s local `FetchLike` type has a
  narrower shape (`{ ok, status, json() }`, not a full `Response`) than
  `@dwk/safe-fetch`'s — `DidWebResolverOptions.fetch` is public API, so it is
  left untouched; internally, `createDidWebResolver` adapts by passing a
  small `Response`-shaped wrapper around the injected `fetchImpl` into
  `safeFetch`, rather than widening the public option type.
- **`packages/atproto-pds/src/resolve.ts:50`** — remote DID resolution (an
  externally-supplied identifier), gets full `safeFetch` treatment the same
  way, `logEvent: "atproto-pds.ssrf.blocked"` (new log event — check
  `packages/atproto-pds/src/log.ts` for the existing naming convention and
  match it).
- **`packages/atproto-pds/src/plc-directory.ts`** (3 call sites: submit,
  resolve, fetch-data) — routed through `safeFetch` for the timeout/redirect
  handling and consistency with the rest of the repo. The host-block is
  effectively a no-op here since `directoryUrl` is operator-configured
  (`DEFAULT_PLC_DIRECTORY = "https://plc.directory"`), not attacker-supplied —
  but there's no reason to hand-roll a separate bare-timeout path when the
  shared primitive already does this correctly, and it preserves the
  existing injectable `fetchImpl` test seam unchanged (it becomes the
  `doFetch` argument to `safeFetch`).

## Out of scope

`@dwk/activitypub`'s outbound delivery/actor-lookup fetches already have
their own `OUTBOUND_TIMEOUT_MS` convention (`packages/activitypub/src/object.ts:797-800`)
and were not flagged as missing SSRF protection in #216's original table —
left alone rather than folding in a sixth migration. `@dwk/activitypub`'s
*inbound* body-size cap (#213) was already fixed in #232 via a
package-local `body.ts`, which is a different concern (capping a request
body being read, not a response) and isn't touched here.

## Testing

- `@dwk/safe-fetch`'s own suite absorbs the SSRF/redirect/body-cap test
  matrix currently spread across the four packages' `safe-fetch.test.ts`
  files — consolidated to the superset (private-host blocking for both IPv4
  and IPv6 forms, redirect re-validation, credential-header stripping
  including the `stripHeadersCrossOrigin` extension, capped-body edge cases,
  the `allowedSchemes` restriction, signal-combining), not just a copy of one.
- Each migrated package keeps a thin test verifying it wires the primitive
  correctly (right `allowedSchemes`, right `logEvent`, right
  `stripHeadersCrossOrigin`) rather than re-testing IP-range parsing that now
  lives in `@dwk/safe-fetch`.
- `@dwk/vc`'s and `@dwk/atproto-pds`'s existing coverage for the #215 call
  sites (did:web resolution, PLC directory calls, remote DID resolution)
  extends to cover the new SSRF-block and timeout paths.

## Release bookkeeping

- New package needs: `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `README.md`, `src/index.ts` doc comment, and a
  `conformance/status.json` entry — reusable libs *are* tracked there (see
  `@dwk/dpop`/`@dwk/rdf`/`@dwk/log`/`@dwk/oauth`, each with `"standard": null`,
  empty `suites`, and `"integration": {"status": "pending", "cases": []}`);
  `@dwk/safe-fetch` gets the same shape.
- A `pnpm changeset` covering `@dwk/safe-fetch` (new package, minor) and each
  migrated package (`@dwk/webmention`, `@dwk/websub`, `@dwk/microsub`,
  `@dwk/vc`, `@dwk/atproto-pds` — patch: internal refactor plus the #215
  bug fix, no public API change for any of them, since `did-web.ts`'s
  `FetchLike` type is left untouched per the resolution above).
- CLAUDE.md's package-count prose and taxonomy tables get a new
  `@dwk/safe-fetch` entry under "Cross-standard reusable libs."
