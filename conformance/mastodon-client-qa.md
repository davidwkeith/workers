# Mastodon-compatible client API — QA runbook

Manual acceptance test for `@dwk/mastodon-api` phase 3 (issue #350),
companion to [`pixelfed-qa.md`](./pixelfed-qa.md) — this is the read path
that runbook's step 4 could only confirm indirectly (no way for a real
client to browse notifications; see `spec/mastodon-client-api.md`'s
Motivation section). Run this doc, record results here, then update
`status.json` per the last section.

## Scope

- **In scope:** app registration, OAuth round-trip (`verify_credentials`
  renders the owner profile), home timeline rendering (media, content
  warning, alt text), notifications rendering a real like + reply.
- **Out of scope:** Follow notifications — `GET /api/v1/notifications` only
  returns `favourite`/`reblog`/`mention`, because incoming Follows are not
  persisted in the inbox. This remains a documented fidelity gap, not a bug
  to file. Also out of scope: posting or any write action
  (non-goal, no write endpoint exists), streaming (non-goal, no
  `urls.streaming_api` is advertised).

## Environment

|                   |                                                               |
| ----------------- | ------------------------------------------------------------- |
| Target instance   | `conformance.dwk.io`                                          |
| Target actor      | `https://conformance.dwk.io/users/conformance`                |
| Test client 1     | Pixelfed's own app                                            |
| Test client 2     | Tusky                                                         |
| Prerequisite data | The like + reply from `pixelfed-qa.md` step 4 (or equivalent) |

## Prerequisites

- [ ] `pixelfed-qa.md` has been run at least once against this target, so
      the actor's inbox already holds a `Like` and a reply `Create` from a
      real Pixelfed account (step 4 of that runbook). If not, repeat that
      step first — this runbook's Step 3 depends on it.
- [ ] The Pixelfed app and/or Tusky installed and ready to add an account.

## Procedure

### Step 1 — Register and log in from each client

1. In the client, add a new account with instance `conformance.dwk.io`.
2. Complete the OAuth consent flow. The conformance target renders its own
   consent page for this flow (`POST /mastodon-consent` — distinct from
   IndieAuth's `/consent`, same pattern: owner password, then a redirect
   back to the client with `code`/`state`).
3. Confirm the client shows the owner's profile
   (`GET /api/v1/accounts/verify_credentials`).

- [ ] **Pass** (Pixelfed app)
- [ ] **Pass** (Tusky)
- [ ] **Fail** — note what happened: **************\_\_\_\_**************

### Step 2 — Home timeline renders

Prerequisite: the actor has at least one received `Create`/`Announce` in
its inbox (reuse `pixelfed-qa.md`'s follow + publish steps against a second
test account, or any existing federated content).

1. Open the client's home timeline for the `conformance.dwk.io` account.
2. Confirm the published post(s) from `pixelfed-qa.md` step 2 (or any other
   federated content) render, including media, content warning, and alt
   text where present. Confirm the remote display name/avatar render after
   the actor-profile hydration alarm has run.
3. Confirm at least one post published by the target actor itself also appears
   in home, with reply/favourite/reblog counts when the corresponding inbound
   activity exists.

- [ ] **Pass** — timeline renders with media/CW/alt text and hydrated account
      details as expected
- [ ] **Pass** — the owner's own post and available interaction counters render
- [ ] **Fail** — note what's missing: **************\_\_\_\_**************

### Step 3 — Notifications render the pixelfed-qa step-4 like + reply

Using the same Pixelfed test account from `pixelfed-qa.md` step 4 (which
liked and replied to a post), confirm both now render as notifications in
the client's notifications view:

- [ ] **Pass** — the `Like` renders as a favourite notification
- [ ] **Pass** — the reply renders as a mention notification
- [ ] **Fail** — note what's missing: **************\_\_\_\_**************

Do **not** expect a Follow notification here even if the test account also
follows the actor — that's the documented v1 gap (see Scope above), not
something this step is checking for.

## Result

|                    |                       |
| ------------------ | --------------------- |
| Overall result     | ☐ Passing / ☐ Failing |
| Run date           |                       |
| Tester             |                       |
| Notes / follow-ups |                       |

## Recording the result

Fill in the **Result** table above first — date, tester, run notes — before
touching `status.json`. A `"passing"` entry with no corresponding filled-in
run here has no paper trail behind it.

Once every step above passes for a client, record it in
`conformance/status.json`:

```
packages["@dwk/mastodon-api"].suites["mastodon-client-api"].targets.pixelfed-app
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

(similarly for `.targets.tusky`). If any step fails, leave the target at
`"pending"` (or set `"failing"` with a note in this doc under **Result** →
Notes) and file a follow-up issue referencing this run.

## Troubleshooting

- **Client can't find the instance / registration fails** — confirm
  `@dwk/mastodon-api` is actually mounted on the deployed target under
  `/api/`, `/oauth/`, and `/.well-known/` (see `catalog.json`'s
  `mastodon-api` worker entry); `POST /api/v1/apps` is open registration
  with no auth, so a failure here usually means a routing/deploy problem,
  not a credentials problem.
- **Consent page never appears / redirects with an error immediately** —
  client/redirect URI mismatch is a `400`, never a redirect (RFC 6749
  §4.1.2.1); check the client registered a redirect URI that exactly
  matches what it sends to `/oauth/authorize`.
- **Login succeeds but the profile is empty/wrong** — `verify_credentials`
  reads the config-injected owner `account`, not backend data; confirm the
  deployed target's `mastodonConfig.account` is set as expected.
- **Home timeline is empty** — confirm the backend is actually wired
  (`createActivitypubMastodonApi`'s `backend` option); with no backend,
  `GET /api/v1/timelines/home` returns `[]` by design, not an error. Also
  confirm the inbox actually has `Create`/`Announce` rows — a bare-IRI
  `Announce` (a plain boost whose `object` is a string, not an embedded
  object) currently renders as an empty-content status rather than the
  boosted post; this is a known gap, not evidence of a missing row.
- **Notifications are missing the like or reply** — confirm
  `pixelfed-qa.md` step 4 actually completed against _this_ target (the
  Like/reply must be in the same actor's inbox this client is reading);
  also double-check you're not mistaking the absent Follow notification
  (expected, see Scope) for a missing favourite/mention.
- **A notification's status body looks stripped of formatting** — expected
  for anything outside the small allowlist (`p`, `br`, `a`, `span`, `b`,
  `strong`, `i`, `em`, `ul`, `ol`, `li`); the sanitizer is fail-safe by
  design (anything it can't confidently parse as one of those tags is
  HTML-escaped, not passed through), so unusual markup degrading to plain
  text is correct behavior, not a bug.
