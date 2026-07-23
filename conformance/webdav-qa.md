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

|                     |                                                          |
| ------------------- | -------------------------------------------------------- |
| WebDAV mount         | `https://conformance.dwk.io/dav/`                        |
| Credential mint      | `POST https://conformance.dwk.io/dav-credentials`         |
| Credential auth      | Bearer `CONFORMANCE_ADMIN_TOKEN` (Cloudflare Worker secret) |
| Mount auth           | Basic, using the minted app password                     |

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

- [ ] **Pass** — credential minted
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

- [ ] **Pass** — `2xx`
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

| Input       | Value                             |
| ----------- | ---------------------------------- |
| `standard`  | `webdav`                           |
| `target_url`| `https://conformance.dwk.io`       |
| `target_id` | `cloudflare` (default)             |

This only succeeds if the `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` repo secrets
are already set to the values from Step 1 — the workflow reads them from
secrets, not from dispatch inputs (Basic credentials aren't something you'd
want in a workflow_dispatch form field anyway). Update the secrets before
dispatching if you minted a fresh credential this run.

Record which path was used and the outcome (litmus reports a per-group
pass/fail/skip summary at the end of its run — `basic`, `copymove`, `props`,
`locks`):

| litmus group | Pass/Fail/Skip | Notes |
| ------------- | -------------- | ----- |
| `basic`       |                |       |
| `copymove`    |                |       |
| `props`       |                |       |
| `locks`       |                |       |

- [ ] **Pass** — every group passes (litmus exits `0`)
- [ ] **Fail** — which group(s) and why: **************\_\_\_\_**************

### Step 4 — Revoke the credential

Always do this after the run, pass or fail — app passwords minted for
testing shouldn't linger:

```bash
curl -sS -X DELETE "https://conformance.dwk.io/dav-credentials?id=<credentialId>" \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN"
```

- [ ] **Pass** — credential revoked
- [ ] **Fail** — status/body: **************\_\_\_\_**************

## Result

|                     |                                        |
| ------------------- | -------------------------------------- |
| Overall result       | ☐ Passing / ☐ Failing                 |
| Run date             | **************\_\_\_\_************** |
| Tester               | **************\_\_\_\_************** |
| Invocation path      | ☐ Local / ☐ CI (link the run)          |
| Notes / follow-ups   | **************\_\_\_\_************** |

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
  `packages/conformance-target` from the dispatched ref first; a *local*
  litmus run against `conformance.dwk.io` does not redeploy anything, so
  confirm the last deploy actually included your change (see
  `packages/conformance-target/README.md`'s Deploy section) before trusting
  a local-path failure as new.
