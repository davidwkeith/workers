# Test-coverage analysis & proposed improvements

_Date: 2026-06-04 · branch: `claude/test-coverage-analysis-FBRAy`_

This is a snapshot of where the test suite is strong, where it is thin, and a
prioritized list of where to invest next. It favors **branch coverage of
security-critical negative paths** over raw line counts — for this codebase the
untested branches are the authorization, token-validation, and SSRF-guard
rejection paths, which is exactly where a regression is a security bug rather
than a cosmetic one.

## Implementation status (this PR)

The recommendations below have been implemented. The suite went from ~610 to
**710 tests**, and aggregate coverage rose to **88.5% stmt / 79.6% branch /
95.5% func / 91.2% line**. Highlights:

- **P1** — solid-pod edge-token rejection ladder (`token_malformed`, `no_jwks`,
  `issuer/audience_mismatch`, `token_expired`, `webid/cnf/dpop_missing`,
  `dpop_invalid`); SSRF redirect guards in websub/webmention (`fetch.ts` 70→100%
  branch, redirect-to-private rebound, `too_many_redirects`, cross-origin
  credential stripping); indieauth token/routing error paths (`handler.ts`
  89→98%).
- **P2** — micropub routing/query/action edge cases (`handler.ts` 70→76%
  branch); activitypub `config.ts` **39→95% stmt** (the default key resolver's
  rejection branches).
- **P3** — fail-loud-on-missing-binding tests added for **solid-pod** and
  **store** (previously zero); solid-pod `gc.ts` **0→96%**; http-signatures
  derived components + structured-field parse errors; log `metrics.ts` →100%.
- **I-1** — coverage now runs in CI (`@vitest/coverage-istanbul`, a `test:coverage`
  script, and a non-regression threshold floor in `vitest.config.ts`).
- **I-2** — a cross-package **composition-contract test** mounts
  `@dwk/indieauth` and `@dwk/micropub` behind one router on one unioned `Env`
  (`packages/micropub/src/composition.test.ts`).

Still open (lower priority, left as the next ratchet): activitypub `object.ts`
(58% branch), solid-pod `pod.ts` conflict/GC-internal paths (65% branch) and
`auth.ts`'s custom-`authenticate` hook branch, and rdf `jsonld.ts` (78% branch).

The original analysis follows.

## How these numbers were produced

`@vitest/coverage-v8` cannot instrument the `workerd` pool
(`@cloudflare/vitest-pool-workers`) — it imports `node:inspector/promises`,
which the Workers runtime does not provide, so every workerd project errors out.
The numbers below were therefore gathered with **two providers**:

| Environment                  | Packages                                                                             | Provider   |
| ---------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| Node (`environment: "node"`) | `dpop`, `http-signatures`, `log`, `rdf`, `wac`, `webfinger`                          | `v8`       |
| `workerd` (pool-workers)     | `activitypub`, `indieauth`, `micropub`, `solid-pod`, `store`, `webmention`, `websub` | `istanbul` |

`istanbul` (babel-instrumented) works under both, so it is the right choice if
we want one provider for the whole repo (see recommendation **I-1**). A build
(`pnpm build`) is required first because workspace deps resolve to `dist/`.

## Current coverage (statements / branch)

| Package           | Stmts | Branch | Notable weak spots (file — stmt/branch)                                      |
| ----------------- | ----: | -----: | ---------------------------------------------------------------------------- |
| `webfinger`       |  97.5 |   96.8 | healthy                                                                      |
| `wac`             |  96.3 |   96.8 | healthy                                                                      |
| `log`             |  96.4 |   80.8 | `metrics.ts` funcs 72% (uncalled metric helpers)                             |
| `store`           |  93.6 |   86.4 | `sql.ts` 86/80                                                               |
| `webmention`      |  93.5 |   85.8 | `fetch.ts` 84/70, `verify.ts` branch 75                                      |
| `dpop`            |  91.6 |   91.5 | healthy                                                                      |
| `rdf`             |  89.7 |   78.5 | `jsonld.ts` branch 78                                                        |
| `indieauth`       |  89.3 |   83.6 | **`handler.ts` funcs 51%**, `token.ts` 81/81, `metadata.ts` 75/50            |
| `websub`          |  85.9 |   77.4 | **`fetch.ts` 69/41**, **`safe-fetch.ts` 79/70**, `distribute.ts` funcs 60    |
| `micropub`        |  84.3 |   76.3 | `handler.ts` 80/70, `mf2.ts` 86/76                                           |
| `activitypub`     |  83.1 |   70.7 | **`config.ts` 39/54**, `object.ts` 79/58, `signature.ts` branch 75           |
| `http-signatures` |   ~84 |    ~70 | **`components.ts` 67/43**, `algorithms.ts` 74/61, `sf.ts` 80/58              |
| `solid-pod`       |  80.6 |   70.0 | **`auth.ts` 64/59**, **`pod.ts` 77/65**, **`gc.ts` 0%**, `encoding.ts` 69/50 |

The aggregate hides the real risk: the _lowest-covered files are the
security-critical ones_ (edge-token validation, the authz Durable Object, the
SSRF guards, HTTP-signature verification), while the high scorers are the
pure-data libs.

## Prioritized recommendations

### P1 — Security-critical negative paths

These are the branches where "untested" means "an auth/SSRF bypass could land
without a test going red."

**1. `solid-pod/src/auth.ts` — edge access-token validation (64% stmt / 59% branch).**
The happy path is well covered, but the rejection ladder mostly is not. Each
`reason` is its own branch and deserves a focused assertion:
`token_malformed`, `no_jwks`, `signature_invalid`, `token_type_invalid`
(`at+jwt` enforcement — an ID token replayed as an access token), `issuer_mismatch`,
`audience_mismatch`, `token_expired`, `token_not_yet_valid` (`nbf` present but
malformed _and_ in the future), `webid_missing`, `cnf_missing`, `dpop_missing`,
`dpop_invalid`. A table-driven test (one row per reason) closes this cheaply.

**2. SSRF redirect-following guards — `websub/src/safe-fetch.ts` (70% branch),
`websub/src/fetch.ts` (41% branch), `webmention/src/fetch.ts` (70% branch).**
The static `assertPublicUrl` checks are tested; the _redirect chain_ is the gap,
and it is where the guarantees actually live. Add cases for: a public host that
302-redirects to a private/loopback/link-local host (must be re-blocked on the
hop, not just the first URL); `> maxRedirects` → `too_many_redirects`; a redirect
with empty/missing `Location`; and **cross-origin credential stripping** (verify
`authorization`, `cookie`, `x-hub-signature`, etc. are dropped when the origin
changes, and _preserved_ when it does not).

**3. `indieauth/src/handler.ts` (funcs 51%) and `indieauth/src/token.ts` (81/81).** Half the
handler functions are never entered. Exercise the authorization-endpoint and
token-endpoint error responses end to end: invalid/expired/replayed auth codes,
PKCE `code_verifier` mismatch, redirect-uri mismatch, unsupported
`grant_type`/`response_type`, and the token-revocation/introspection paths.

### P2 — The authority components' branch gaps

**4. `solid-pod/src/pod.ts` — the only Durable Object (77% stmt / 65% branch).**
This is the consistency/authz/notification authority, so its uncovered branches
(roughly the conflict/`If-Match` losing paths and the GC-orphan forwarding +
error handling around lines 1019–1069) are the highest-value remaining target.
Add concurrent-write/`If-Match` conflict tests and assert orphaned R2 keys are
forwarded to the GC table on copy-on-write displacement and delete.

**5. `activitypub/src/config.ts` (39% stmt).** The forwarded-config /
`deriveIris` logic behind the front door is barely exercised; `object.ts` is at
58% branch. Given AS2 object shaping drives delivery, broaden the
malformed/partial-object and IRI-derivation cases.

**6. `micropub/src/handler.ts` (70% branch).** Cover the create/update/delete
and form-vs-JSON branches plus the error responses (unsupported actions, missing
`h`, scope failures) — `mf2.ts` (76% branch) benefits from the same.

### P3 — Wiring, fail-loud, and library edges

**7. Fail-loud-on-missing-binding is tested inconsistently.** The composition
contract requires every package to throw at startup when a required binding is
absent, but the assertions are uneven: `micropub` (3), `activitypub`/`indieauth`/
`webmention`/`websub` (1 each), and **`solid-pod` (0) and `store` (0)** — despite
`solid-pod` carrying the most bindings (DO, R2 `BLOBS`, D1 `GC_DB`). Add an
explicit "missing binding throws" test per package, especially `solid-pod`.

**8. `solid-pod/src/gc.ts` (0%).** The cron wiring is untested. The underlying
`collectGarbage`/`ensureGcSchema` are covered in `@dwk/store`, so this only needs
two thin tests: throws without `BLOBS`, throws without `GC_DB`, and calls through
on the happy path.

**9. `http-signatures/src/components.ts` (43% branch) and `http-signatures/src/sf.ts` (58% branch).**
The `@`-derived component switch is largely one-path: add `@query` with no query
string (the `"?"` fallback), `@scheme`/`@authority` lowercasing,
`@request-target`/`@path`, an unsupported `@`-name → `null`, an absent header →
`null`, and a malformed URL → `null` from `derivationContext`. Structured-field
parsing in `sf.ts` needs malformed-input rows.

**10. `log/src/metrics.ts` (funcs 72%).** Several metric helpers are never
called by any test. Either add coverage or, if they are genuinely unused, treat
it as dead-code removal — both improve signal.

### Infrastructure

**I-1. There is no coverage measurement in CI.** Coverage isn't wired into
`ci.yml` and neither provider is a dependency. Recommend adding
`@vitest/coverage-istanbul` (works under _both_ node and workerd, unlike v8) and
a `pnpm test:coverage` script, then gating new code with per-package thresholds
once the P1/P2 gaps are closed (set initial thresholds at current levels to
prevent regression, then ratchet up).

**I-2. No cross-package composition test exists.** The composition contract —
several `createX` handlers mounted under path prefixes behind one Worker/`Env` —
is central to the project's design but only ever tested one package at a time.
Add one integration test that mounts, say, `indieauth` + `micropub` +
`webmention` behind a single router and asserts prefix routing and the unioned
`Env` work together. This guards the contract the whole repo is built around.

## Suggested sequencing

1. P1 (auth.ts rejection table, SSRF redirect guards, indieauth handler/token) —
   highest security value, mostly cheap table-driven additions.
2. I-1 coverage in CI with non-regression thresholds, so the P1 work is locked in.
3. P2 (pod.ts conflict/GC, activitypub config/object, micropub handler).
4. P3 + I-2 (fail-loud per package, gc wiring, http-signatures components,
   composition test).
