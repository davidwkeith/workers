# micropub.rocks — QA runbook

Manual acceptance test for `@dwk/micropub` against the hosted
[micropub.rocks](https://micropub.rocks/) test suite. This is the fillable,
step-by-step companion to the terse checklist in
[`README.md`](./README.md#running-a-hosted-suite) — run this doc, record
results here, then update `status.json` per the last section. Intended to be
re-run before every release that touches `@dwk/micropub` or its IndieAuth
dependency, not just once.

Unlike WebDAV/litmus or the Fedify ActivityPub peer, micropub.rocks has no
scriptable driver in `scripts/conformance/run-suite.mjs` — it's a hosted web
app you drive by hand through a real IndieAuth authorization flow. This
runbook exists to make that manual flow repeatable and its result
paper-trailed.

## Scope

- **In scope:** endpoint discovery from the homepage, the IndieAuth
  authorization + token exchange, and the full micropub.rocks test matrix
  against `POST /micropub` — create (JSON and form-encoded), update, delete,
  undelete, the media endpoint, `q=config`/`q=source`, and whichever syndication
  / slug / post-status extensions micropub.rocks exercises.
- **Out of scope:** anything micropub.rocks doesn't test — e.g. the `h=event`
  post type and the `q=category` / proposed-group extensions are
  `@dwk/micropub`-specific and have their own colocated unit tests instead
  (see `spec/packages/micropub.md`).

## Environment

|                        |                                                          |
| ---------------------- | -------------------------------------------------------- |
| Test identity ("Me")   | `https://conformance.dwk.io/`                             |
| Discovery              | `rel="micropub"`, `authorization_endpoint`, `token_endpoint` link tags on the homepage (see `packages/conformance-target/src/home.ts`) |
| Micropub endpoint      | `https://conformance.dwk.io/micropub`                     |
| Media endpoint         | `https://conformance.dwk.io/media/`                       |
| Authorization endpoint | `https://conformance.dwk.io/authorize`                    |
| Token endpoint         | `https://conformance.dwk.io/token`                        |
| Consent auth           | `CONFORMANCE_PASSWORD` (Cloudflare Worker secret)          |

Discovery is confirmed wired up — the homepage's `<link>` tags mean
micropub.rocks (or any IndieAuth client) can go straight from the "Me" URL to
every endpoint below without being told them individually.

## Prerequisites

- [ ] The `CONFORMANCE_PASSWORD` value for the deployed target (needed to
      approve the consent screen — never pasted into a shared doc or repo,
      only typed into the live form).
- [ ] `POST /admin/init` has been run at least once against this deployment
      (see `packages/conformance-target/README.md` — a fresh D1 database
      500s on the consent flow until its schema exists).

## Procedure

### Step 1 — Start a test run and let it discover the target

1. Go to https://micropub.rocks/.
2. Start a new test client / test run, entering `https://conformance.dwk.io/`
   as your website ("Me").
3. Confirm micropub.rocks reports finding the `authorization_endpoint`,
   `token_endpoint`, and `micropub` endpoint via the discovered link tags,
   without you entering them by hand.

- [ ] **Pass** — all three endpoints auto-discovered
- [ ] **Fail** — note what happened: **************\_\_\_\_**************

### Step 2 — Complete the IndieAuth authorization

1. micropub.rocks redirects you to `GET /authorize` on the deployed target.
2. The conformance target renders its own consent form (no client has a
   pre-signed consent token yet). Enter `CONFORMANCE_PASSWORD` and approve.
3. Confirm you land back on micropub.rocks with a granted access token (it
   will say so, or move straight into the test list).

- [ ] **Pass** — token obtained, test list becomes available
- [ ] **Fail** — status/error shown: **************\_\_\_\_**************

### Step 3 — Run the full test matrix

Work through micropub.rocks' numbered test list (it groups tests by feature —
form-encoded create, JSON create, updates, deletes/undeletes, media upload,
query support, and the command extensions it knows about). For each test,
micropub.rocks shows the raw request it sent and a pass/fail verdict with
reasoning.

Record the overall tally here (fill in as run; exact test numbering/labels
are micropub.rocks' own and may change between runs — don't hardcode them
into this doc):

| Category                              | Pass/Fail | Notes |
| -------------------------------------- | --------- | ----- |
| Form-encoded create                    |           |       |
| JSON create                            |           |       |
| Update (`replace`/`add`/`delete`)      |           |       |
| Delete / undelete                      |           |       |
| Media endpoint upload                  |           |       |
| `q=config` / `q=source`                |           |       |
| Command extensions (slug, syndication) |           |       |

- [ ] **Pass** — every required test in the matrix passes
- [ ] **Fail** — list which tests failed and why: **************\_\_\_\_**************

### Step 4 — Publish the implementation report (optional but recommended)

micropub.rocks can publish a shareable implementation report URL
(`https://micropub.net/implementation-reports/…`) summarizing the run. If you
generate one, record its URL in `status.json`'s `report` field (see below) —
that's what the field is for.

## Result

|                        |                                        |
| ---------------------- | -------------------------------------- |
| Overall result         | ☐ Passing / ☐ Failing                  |
| Run date                | **************\_\_\_\_************** |
| Tester                  | **************\_\_\_\_************** |
| Implementation report   | **************\_\_\_\_************** |
| Notes / follow-ups      | **************\_\_\_\_************** |

## Recording the result

Fill in the **Result** table above first — date, tester, and report URL if
any — before touching `status.json`. A `"passing"` entry with no
corresponding filled-in run here has no paper trail behind it.

Once the matrix passes, record it in `conformance/status.json`:

```
packages["@dwk/micropub"].suites["micropub.rocks"]
  = { "status": "passing", "report": "<implementation-report URL or null>", "lastRun": "<ISO-8601 timestamp>" }
```

If any required test fails, leave the suite at `"pending"` (or set
`"failing"` with a note in this doc under **Result** → Notes) and file a
follow-up issue referencing this run.

## Troubleshooting

- **Discovery fails / micropub.rocks can't find the endpoints** — fetch
  `https://conformance.dwk.io/` yourself and confirm the `<link>` tags are
  present (`view-source:` or `curl`); a redeploy that regressed `home.ts`
  would break this silently from micropub.rocks' point of view (it just
  falls back to asking you to enter endpoints manually).
- **`/authorize` 500s** — the D1 schema hasn't been initialized on this
  deployment; run `POST /admin/init` with `CONFORMANCE_ADMIN_TOKEN` first
  (see `packages/conformance-target/README.md`).
- **Consent form rejects the password** — confirm `CONFORMANCE_PASSWORD` is
  actually set as a Worker secret on this deployment (`wrangler secret
  list`), not just assumed; an unset secret refuses unconditionally by
  design (see `approval.ts`'s `createConsent`).
- **Token exchange succeeds but every Micropub request 401s** — the token's
  scope may not cover `create`/`update`/`delete`; re-run the authorization
  with a broader `scope` parameter if micropub.rocks lets you set one.
- **Media endpoint tests fail** — confirm the deployed target's R2 binding
  for media is actually wired (see `catalog.json`'s micropub worker entry);
  a missing binding fails loudly at startup per the composition contract, so
  a silent 404/500 instead usually means a stale deploy.
