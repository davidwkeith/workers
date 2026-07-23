# webmention.rocks — QA runbook

Manual acceptance test for `@dwk/webmention` against the hosted
[webmention.rocks](https://webmention.rocks/) receiver and sender test
suites. This is the fillable, step-by-step companion to the terse checklist
in [`README.md`](./README.md#running-a-hosted-suite) — run this doc, record
results here, then update `status.json` per the last section. Intended to be
re-run before every release that touches `@dwk/webmention`, not just once.

Like micropub.rocks, webmention.rocks has no scriptable driver in
`scripts/conformance/run-suite.mjs` — it's a hosted web app you drive by
hand. Unlike micropub.rocks it needs no auth (Webmention has no bearer
token — anyone can submit a mention), so the receiver half of this runbook
has no credential blocker.

## Scope

- **Receiver — in scope today.** `POST /webmention` on the deployed target:
  parameter validation (`source`/`target` present and well-formed, `target`
  under this receiver's control), async verification via the queue, and
  storage to the inbox.
- **Sender — currently blocked, not just untested.** `@dwk/webmention`
  ships a `sendWebmention`/`sendWebmentions` library (discover the target's
  endpoint, notify on publish), but **the conformance target doesn't wire it
  to anything** — `packages/conformance-target/src/mounts.ts` only mounts the
  receiver route (`/webmention`) and the verification queue consumer; there
  is no on-publish hook and no standalone "send a webmention" HTTP endpoint
  on this deployment. Publishing a post via Micropub does **not** trigger a
  send. Until that wiring exists (or a temporary trigger endpoint is added
  for this test), the sender suite cannot be run against `conformance.dwk.io`
  at all — this isn't a result to record as `"pending"`, it's a real gap to
  fix first. See Step 2 below before assuming you can just start clicking
  through webmention.rocks/sender.

## Environment

|                  |                                                             |
| ---------------- | ------------------------------------------------------------- |
| Receiver endpoint | `https://conformance.dwk.io/webmention`                      |
| Target host       | `conformance.dwk.io` (any path under it is accepted — the receiver only checks the target's **host**, not that the path resolves to a real page; see `packages/webmention/src/validate.ts`) |
| Verification      | Async, via the `conformance-webmention` queue — allow a few seconds between sending a test mention and checking its stored/verified state |

## Prerequisites

- [ ] A target URL under `conformance.dwk.io` to hand to webmention.rocks as
      "your target" for the whole receiver run — the homepage
      (`https://conformance.dwk.io/`) works fine, or a dedicated path like
      `https://conformance.dwk.io/webmention-qa-target` if you'd rather keep
      test mentions distinguishable from real traffic.
- [ ] A way to inspect the inbox after each test (ask the session to query
      the target's D1 inbox table, since there's no public "list received
      mentions" page on this deployment).

## Procedure — Receiver

### Step 1 — Run the receiver test suite

1. Go to https://webmention.rocks/, start the receiver tests.
2. Enter `https://conformance.dwk.io/webmention` as your receiver endpoint
   and the target URL from Prerequisites above.
3. Work through each numbered test (multiple `Link` header/HTML link
   variants, relative URLs, redirects, updates to a previously-sent source,
   deletion of a previously-sent source, non-HTML content types, etc.).
   webmention.rocks sends the mention itself and reports its own verdict
   based on your endpoint's HTTP response (`202`/`201` and, where
   applicable, a `Location` header) — it does not need read access to your
   inbox to score the initial submission.
4. For a sample of tests (not necessarily all), confirm the mention actually
   landed in the inbox in the expected shape after async verification —
   this is the one thing webmention.rocks itself can't see from the outside.

Record the tally (exact test numbering is webmention.rocks' own and may
change between runs — don't hardcode it into this doc):

| Category                                  | Pass/Fail | Notes |
| ------------------------------------------ | --------- | ----- |
| Basic source/target discovery              |           |       |
| `Link` header variants                     |           |       |
| Relative/malformed URL handling            |           |       |
| Redirect chains                            |           |       |
| Update to a previously-sent source         |           |       |
| Deletion of a previously-sent source       |           |       |
| Non-HTML source content types              |           |       |

- [ ] **Pass** — every required receiver test passes
- [ ] **Fail** — list which tests failed and why: **************\_\_\_\_**************

## Procedure — Sender

### Step 2 — Confirm (or add) a send trigger before attempting this suite

As documented in Scope, this deployment has no way to make the target
actually send a webmention today. Before running webmention.rocks/sender,
either:

- confirm a publish → send hook (or a standalone trigger endpoint) has since
  been wired into `packages/conformance-target` — check
  `packages/conformance-target/src/mounts.ts` for a `sendWebmention(s)` call
  that isn't there as of this doc's writing — or
- treat this as blocked and stop here, filing/linking an issue for the
  wiring gap instead of attempting the suite.

- [ ] **Confirmed a send trigger exists on this deployment** (describe it):
      **************\_\_\_\_**************
- [ ] **Still blocked** — no trigger exists; sender suite not attempted this run

### Step 3 — Run the sender test suite (only once Step 2 is unblocked)

1. Go to https://webmention.rocks/, start the sender tests. It gives you a
   series of source-page URLs on webmention.rocks representing discovery
   edge cases (link position in HTML, `Link` header, relative URLs, etc.).
2. For each, trigger the target's sender against that URL as source (however
   the trigger from Step 2 works) with a target on webmention.rocks that
   points back at the test.
3. webmention.rocks reports whether it received a correctly-formed mention
   for each case.

- [ ] **Pass** — every required sender test passes
- [ ] **Fail** — list which tests failed and why: **************\_\_\_\_**************

## Result

|                     |                                        |
| ------------------- | -------------------------------------- |
| Receiver result      | ☐ Passing / ☐ Failing                 |
| Sender result        | ☐ Passing / ☐ Failing / ☐ Blocked (no send trigger) |
| Run date             | **************\_\_\_\_************** |
| Tester               | **************\_\_\_\_************** |
| Notes / follow-ups   | **************\_\_\_\_************** |

## Recording the result

Fill in the **Result** table above first — date, tester, and notes — before
touching `status.json`. A `"passing"` entry with no corresponding filled-in
run here has no paper trail behind it.

Once the receiver matrix passes, record it in `conformance/status.json`:

```
packages["@dwk/webmention"].suites["webmention.rocks/receiver"]
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

Leave `webmention.rocks/sender` at `"pending"` until the send-trigger gap
(Scope, above) is closed and the suite has actually been run — don't mark it
`"passing"` on the strength of the receiver alone, and don't mark it
`"failing"` for a suite that was never runnable in the first place.

## Troubleshooting

- **Every receiver test 400s immediately** — confirm the target URL's host
  matches `conformance.dwk.io` (or an `allowedHosts` entry); a target on any
  other host is rejected by design (`validate.ts`), which is correct
  behavior for a foreign target, not a bug, but will fail the whole suite if
  you gave webmention.rocks the wrong target host by mistake.
- **`202`/`201` returned but the mention never appears in the inbox** —
  check the `conformance-webmention` queue actually processed the message
  (queue consumers can silently stall if the deployment's queue binding is
  misconfigured); also confirm enough time has passed — verification is
  async by design, not instant.
- **A previously-verified mention doesn't disappear after its source is
  deleted (410 or removed)** — confirm this is the re-verification path
  (async, on the next verification pass), not the sender's documented gap
  (§3.1.5 "SHOULD re-send on delete" — that's about the *sending* side
  proactively notifying, which `@dwk/webmention` intentionally doesn't do;
  see `spec/packages/webmention.md`'s Known gaps). The receiving side
  re-verifying and dropping the mention is the mechanism that's supposed to
  work here.
