# WebDAV / litmus — QA runbook

Acceptance test for `@dwk/webdav`/`@dwk/solid-pod`'s WebDAV door against the
[litmus](http://www.webdav.org/neon/litmus/) conformance suite. This is the
fillable, step-by-step companion to the terse checklist in
[`README.md`](./README.md#running-litmus-webdav-conformance) and the fuller
setup notes in
[`packages/conformance-target/README.md`](../packages/conformance-target/README.md#running-litmus-webdav-conformance)
— run this doc, record results here, then update `status.json` per the last
section. Intended to be re-run before every release that touches
`@dwk/webdav`, not just once.

Unlike micropub.rocks/webmention.rocks, litmus **is** wired into
`scripts/conformance/run-suite.mjs` and the CI `hosted-suite` job — this
runbook is mostly about the one-time-per-run credential setup that isn't
(and shouldn't be) automated, plus the two ways to actually invoke it.

## Scope

- **In scope:** basic PUT/GET/DELETE round-trips, `COPY`/`MOVE` (resource +
  collection, `Depth`/`Overwrite`), `PROPFIND` (`Depth` 0/1, live properties),
  and Class 2 `LOCK`/`UNLOCK` semantics against the `/dav` door — the
  litmus suite's `basic`, `copymove`, `props`, and `locks` test groups.
- **Out of scope:** anything the litmus suite doesn't cover — e.g. the
  owner-gated app-password mint/list/revoke endpoints
  (`createSolidPodWebdavCredentials`) are exercised by this runbook only as
  a means to get credentials, not as their own test target (they have
  colocated unit tests instead).

## Environment

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| WebDAV mount    | `https://conformance.dwk.io/dav/`                           |
| Credential mint | `POST https://conformance.dwk.io/dav-credentials`           |
| Credential auth | Bearer `CONFORMANCE_ADMIN_TOKEN` (Cloudflare Worker secret) |
| Mount auth      | Basic, using the minted app password                        |

## Prerequisites

- [ ] The `CONFORMANCE_ADMIN_TOKEN` value for the deployed target.
- [ ] Either `litmus` installed locally (`apt-get install litmus` / `brew
install litmus`) **or** the `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` GitHub
      Actions repo secrets set, so the CI `hosted-suite` job can run it
      instead (Settings → Secrets and variables → Actions). Without either,
      neither invocation path below works — the CI job fails fast with
      `litmus needs Basic credentials` if the secrets are unset, it doesn't
      silently skip.

## Procedure

### Step 1 — Mint a read-write app password

```bash
curl -sS -X POST https://conformance.dwk.io/dav-credentials \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"litmus","scope":{"modes":["read","write"]}}'
```

Save the response's `username`, `secret` (shown once), and `credentialId` —
you'll need all three later.

- [x] **Pass** — credential minted
- [ ] **Fail** — status/body: **************\_\_\_\_**************

### Step 2 — Seed the pod

The pod is lazily materialized, so `PROPFIND` on an empty pod 404s even for
the owner. Write one resource first:

```bash
curl -sS -X PUT https://conformance.dwk.io/dav/seed.txt \
  -u "<username>:<secret>" \
  -H "Content-Type: text/plain" \
  -d seed
```

- [x] **Pass** — `2xx`
- [ ] **Fail** — status/body: **************\_\_\_\_**************

### Step 3 — Run litmus

Pick **one** of these two paths per run (both exercise the same suite; the
CI path is preferred for a repeatable pre-release record since its result
lands in Actions history):

**3a. Locally**, if litmus is installed:

```bash
node scripts/conformance/run-suite.mjs webdav \
  --target https://conformance.dwk.io/dav/ \
  --username <username> --password <secret>
```

**3b. Via CI** — dispatch the `Conformance` workflow (Actions → Conformance →
Run workflow) with:

| Input        | Value                             |
| ------------ | --------------------------------- |
| `standard`   | `webdav`                          |
| `target_url` | `https://conformance.dwk.io/dav/` |
| `target_id`  | `cloudflare` (default)            |

`target_url` must include the `/dav/` mount path, not just the domain —
`run-suite.mjs` passes it straight to `litmus` with no per-standard suffix
logic (unlike the ActivityPub path, which appends `/outbox` itself), so a
bare domain 404s on litmus's very first `MKCOL` and the run aborts before
any real group runs.

This only succeeds if the `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` repo secrets
are already set to the values from Step 1 — the workflow reads them from
secrets, not from dispatch inputs (Basic credentials aren't something you'd
want in a workflow_dispatch form field anyway). Update the secrets before
dispatching if you minted a fresh credential this run.

Record which path was used and the outcome (litmus reports a per-group
pass/fail/skip summary at the end of its run — `basic`, `copymove`, `props`,
`locks`):

| litmus group | Pass/Fail/Skip | Notes                                                                                                                                                                              |
| ------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic`      | Fail (15/16)   | Only failure: `mkcol_over_plain` — `MKCOL` on the UTF-8-named plain resource `res-%e2%82%ac` (created by the preceding `put_get_utf8_segment` test) succeeded instead of refusing. |
| `copymove`   | Skip           | Never ran — this packaged litmus binary stops after the first group with any failure, so `basic` failing means `copymove`/`props`/`locks` are still completely unverified.         |
| `props`      | Skip           | Same as above.                                                                                                                                                                     |
| `locks`      | Skip           | Same as above.                                                                                                                                                                     |

Manually reproducing `mkcol_over_plain`'s exact shape via direct `curl` calls (PUT a plain
resource, then `MKCOL` the identical percent-encoded path, both at the mount root and
nested a level deep) correctly returned `405` every time — so the RFC-compliant check
(`packages/webdav/src/webdav.ts`'s `mkcol()`) is doing the right thing for the request
shape tested by hand. Whatever litmus's `neon` HTTP client actually sends across the two
separate test functions (`put_get_utf8_segment` then `mkcol_over_plain`) reusing that
UTF-8 segment differs in some way not yet isolated — likely a percent-encoding
case/normalization mismatch between the two requests — but the debug detail needed to
confirm this (litmus's own `debug.log`) lives only on the ephemeral CI runner and wasn't
captured. All four of the _other_ litmus-driven `basic` bugs found this session
(`mkcol_no_parent`, `put_no_parent`, `mkcol_over_plain`'s general case, `delete_null`) are
confirmed fixed and passing.

- [ ] **Pass** — every group passes (litmus exits `0`)
- [x] **Fail** — which group(s) and why: `basic` fails on `mkcol_over_plain`'s UTF-8-segment
      reuse case (see Notes above); `copymove`/`props`/`locks` never ran as a result.

### Step 4 — Revoke the credential

Always do this after the run, pass or fail — app passwords minted for
testing shouldn't linger:

```bash
curl -sS -X DELETE "https://conformance.dwk.io/dav-credentials?id=<credentialId>" \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN"
```

- [x] **Pass** — credential revoked
- [ ] **Fail** — status/body: **************\_\_\_\_**************

## Result

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overall result     | ☐ Passing / ☑ Failing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Run date           | 2026-07-23                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tester             | Claude (on behalf of David W. Keith)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Invocation path    | ☐ Local / ☑ CI ([run 30052950880](https://github.com/davidwkeith/workers/actions/runs/30052950880))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Notes / follow-ups | This run followed #407 (fixed `mintAppPassword`'s PBKDF2 iteration count exceeding workerd's ceiling, which blocked credential minting entirely) and #409 (fixed four RFC 4918 conformance bugs: `MKCOL`/`PUT`/`COPY`/`MOVE` onto a missing parent silently succeeding instead of `409`, `MKCOL` over a plain resource silently succeeding instead of `405`, `DELETE` of a nonexistent resource silently succeeding instead of `404`). `basic` now passes 15/16 (up from 12/16 pre-#409, and 0/16 pre-#407); the one remaining failure is a narrower UTF-8-segment-reuse edge case in `mkcol_over_plain` — see the Step 3 table. `copymove`/`props`/`locks` are still unrun since litmus stops after the first group with failures. Filed as a residual gap, not a fresh regression — worth its own follow-up increment. |

## Recording the result

Fill in the **Result** table above first — date, tester, and which path was
used — before touching `status.json`. A `"passing"` entry with no
corresponding filled-in run here has no paper trail behind it.

Once every litmus group passes, record it in `conformance/status.json`:

```
packages["@dwk/webdav"].suites["litmus"]
  = { "status": "passing", "report": "<CI run URL or null>", "lastRun": "<ISO-8601 timestamp>" }
```

If any group fails, leave the suite at `"pending"` (or set `"failing"` with
a note in this doc under **Result** → Notes) and file a follow-up issue
referencing this run.

## Troubleshooting

- **CI job fails immediately with "litmus needs Basic credentials"** — the
  `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` repo secrets aren't set, or are stale
  from a revoked credential. Mint a fresh one (Step 1) and update the
  secrets before re-dispatching.
- **`PROPFIND` on `/dav/` 404s** — the pod hasn't been seeded yet (Step 2);
  this is expected for a freshly-reset deployment, not a bug.
- **`401` on the mount** — wrong username/secret, or the credential was
  already revoked (Step 4 of a previous run); mint a new one.
- **`423 Locked` on a write that should have succeeded** — confirm you're
  not reusing a lock token from a previous, separately-run litmus session;
  litmus manages its own lock lifecycle within a single run but a stray
  external lock can wedge a resource until it expires or is force-unlocked
  by the owner.
- **Deploy is stale / results don't reflect a recent code change** — the CI
  `hosted-suite` job depends on `deploy-target`, which redeploys
  `packages/conformance-target` from the dispatched ref first; a _local_
  litmus run against `conformance.dwk.io` does not redeploy anything, so
  confirm the last deploy actually included your change (see
  `packages/conformance-target/README.md`'s Deploy section) before trusting
  a local-path failure as new.
- **litmus prints a `Usage: .../litmus/basic [OPTIONS] URL [username
password]` message and every test fails/aborts immediately** — the minted
  secret happens to start with `-` (a plausible outcome of the base64url
  alphabet), and litmus's C-style `getopt` argument parser reads it as an
  unrecognized option flag rather than the positional password argument.
  Mint a fresh credential (Step 1) and retry; there's no way to force a
  specific character, so this is just bad luck on the random draw, not a
  bug in `@dwk/webdav`.
- **`begin` fails with `Could not create new collection '/dav/litmus/':
405 Method Not Allowed` even though nothing looks wrong** — a previous
  litmus run aborted partway through (didn't reach the `finish` test, which
  is what normally deletes `/litmus/` at the end) and left `/dav/litmus/`
  populated. `begin`'s first act is to `MKCOL` a fresh `/litmus/`, so a
  leftover one 405s as "already exists" instead of testing anything real.
  Fix: `PROPFIND` `Depth: 1` on `/dav/litmus/` as the owner to see what's
  left, then `DELETE` every child bottom-up (deepest first — this door's
  `DELETE` isn't recursive, so a non-empty collection 409s) before deleting
  `/dav/litmus/` itself and retrying.
