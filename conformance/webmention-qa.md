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
- **Sender — now runnable.** `@dwk/webmention` ships a
  `sendWebmention`/`sendWebmentions` library (discover the target's endpoint,
  notify on publish). `packages/conformance-target` wires it to an
  owner-gated trigger, `POST /webmention/send` (`src/webmention-send.ts`,
  mounted in `src/mounts.ts`) — mirroring the ActivityPub `/publish` pattern
  rather than an on-publish Micropub hook, because webmention.rocks/sender
  hands back an arbitrary source-page URL per discovery edge case that this
  deployment never actually published, so a standalone
  `{source, target}` trigger is what the suite's own procedure needs (see
  Step 2 below). Closed by
  [#405](https://github.com/davidwkeith/workers/issues/405).

## Environment

|                   |                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receiver endpoint | `https://conformance.dwk.io/webmention`                                                                                                                                                     |
| Target host       | `conformance.dwk.io` (any path under it is accepted — the receiver only checks the target's **host**, not that the path resolves to a real page; see `packages/webmention/src/validate.ts`) |
| Verification      | Async, via the `conformance-webmention` queue — allow a few seconds between sending a test mention and checking its stored/verified state                                                   |

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

> **2026-07-27 note:** webmention.rocks' own site currently says "The formal
> test suite for testing Webmention receivers is in progress" and offers only
> two numbered tests (`/receive/1`, `/receive/2`, both IndieAuth-sign-in
> gated), not the richer numbered-variant suite this doc originally
> anticipated. Broader coverage (redirects, updates, deletes, non-HTML
> content types) is only available via a third-party CLI tool linked from the
> site (`node-webmention-testpinger`), which this run did not exercise. The
> table below reflects what the site's current formal suite actually covers.

Record the tally (exact test numbering is webmention.rocks' own and may
change between runs — don't hardcode it into this doc):

| Category                             | Pass/Fail | Notes                                                                                                                                      |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Basic source/target discovery        | Pass      | Receiver Test #1: `Link` header discovered, `202` returned, accepted                                                                       |
| `Link` header variants               | N/A       | Only the homepage's own `Link: rel=webmention` header was exercised; no HTML-tag/relative-URL variants offered by the current hosted suite |
| Relative/malformed URL handling      | Pass      | Receiver Test #2: invalid source, invalid target, and invalid source+target all correctly `400`ed                                          |
| Redirect chains                      | N/A       | Not offered by the current hosted suite (see 2026-07-27 note above)                                                                        |
| Update to a previously-sent source   | N/A       | Not offered by the current hosted suite                                                                                                    |
| Deletion of a previously-sent source | N/A       | Not offered by the current hosted suite                                                                                                    |
| Non-HTML source content types        | N/A       | Not offered by the current hosted suite                                                                                                    |

- [x] **Pass** — every required receiver test passes
- [ ] **Fail** — list which tests failed and why: **************\_\_\_\_**************

Receiver Test #1's mention was confirmed in the D1 inbox
(`dwk-conformance-webmention` / `webmentions` table) fully verified —
`verified_at` set, `interaction_type: "reply"`, `author_photo` and `content`
extracted from webmention.rocks' h-entry markup.

## Procedure — Sender

### Step 2 — The send trigger

`POST /webmention/send` (owner-gated, `CONFORMANCE_ADMIN_TOKEN`) drives the
sender against an arbitrary `{source, target}` pair — see
`packages/conformance-target/README.md`'s "Running webmention.rocks/sender"
section for the exact `curl` invocation. Confirm it's live before starting
the suite:

```bash
curl -sS -X POST https://conformance.dwk.io/webmention/send \
  -H "Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"https://example.com/","target":"https://example.com/"}'
```

should return `200` with a JSON `SendResult` body (not `404`).

- [x] **Confirmed the send trigger responds on this deployment**

### Step 3 — Run the sender test suite

1. Go to https://webmention.rocks/, start the sender tests. It gives you a
   series of source-page URLs on webmention.rocks representing discovery
   edge cases (link position in HTML, `Link` header, relative URLs, etc.).
2. For each, `POST /webmention/send` with that URL as `source` and a target
   on webmention.rocks that points back at the test (see Step 2).
3. webmention.rocks reports whether it received a correctly-formed mention
   for each case.

> **2026-07-27 note (superseding Step 3's description above):** the actual
> webmention.rocks UI has this backwards from what this doc assumed —
> `webmention.rocks/test/1`..`/test/23` (plus `/update/1`, `/update/2`,
> `/delete/1`) are the **targets**, each advertising its own endpoint in a
> different way; webmention.rocks does not hand back a ready-made `source`
> URL. A real run of `sendWebmention` needs a `source` page that actually
> contains an `<a href>` to the target — webmention.rocks fetches `source`
> synchronously and rejects with `400 no_link_found` otherwise (verified via
> a direct `curl` to `https://webmention.rocks/test/1/webmention`, confirming
> this is webmention.rocks' real behaviour, not a fluke). This deployment has
> no such source page yet (`packages/conformance-target/src/home.ts`'s own
> "Grows test posts for webmention.rocks in P2" comment — never done); see
> [#457](https://github.com/davidwkeith/workers/issues/457).
>
> Ran `POST /webmention/send` against all 26 targets (`test/1`-`test/23`,
> `update/1`, `update/2`, `delete/1`) with `source` = the conformance
> homepage, to isolate discovery from delivery:
>
> - **Discovery: 26/26 correct.** The resolved `endpoint` matched each test's
>   documented expected behaviour, including every trap case — HTML-comment
>   decoy (`test/13`), escaped-HTML decoy (`test/14`), empty `href` resolving
>   to the page's own URL (`test/15`), missing `href` (`test/20`), redirect
>   chain with endpoint resolved relative to the _final_ URL (`test/23`,
>   using its documented `/test/23/page` entry point), and endpoint query
>   strings (`test/21`).
> - **Delivery: 0/26.** Every attempt returned `delivered: false, status:
400` — `no_link_found`, for the reason above. This is a content gap in
>   `@dwk/conformance-target`, not a `@dwk/webmention` sender bug.

> **2026-07-27 follow-up run (#457, closing the gap above):**
> `packages/conformance-target/src/home.ts` now serves
> `/webmention-qa-source`, an `h-entry` page with a real `<a href>` to each of
> the 26 targets. Re-ran `POST /webmention/send` for all 26 with `source` =
> `https://conformance.dwk.io/webmention-qa-source`:
>
> - **First pass: 25/26 delivered `200`.** `test/23` (the redirect-chain
>   case) came back `endpoint: null, delivered: false, status: 0` — discovery
>   itself failed. Root cause: the target passed was
>   `https://webmention.rocks/test/23`, but that test's own page says "send a
>   Webmention to the URL below" = `test/23/page` — `test/23` is only the
>   human-readable description, `test/23/page` is the actual redirect entry
>   point the earlier discovery-only run (above) had used. Fixed by pointing
>   both the source page's link and the `target` at `test/23/page`
>   (`packages/conformance-target/src/home.ts`), redeployed, re-sent.
> - **Second pass: 26/26 delivered `200`.** Every target, including
>   `test/23/page`, returned `delivered: true, status: 200`.

- [x] **Pass** — every required sender test passes
- [ ] **Fail** — list which tests failed and why: **************\_\_\_\_**************

## Result

|                    |                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receiver result    | ☑ Passing / ☐ Failing                                                                                                                                                                                                      |
| Sender result      | ☑ Passing / ☐ Failing                                                                                                                                                                                                      |
| Run date           | 2026-07-27                                                                                                                                                                                                                 |
| Tester             | Claude Code session, with David W. Keith supplying `CONFORMANCE_ADMIN_TOKEN` and approving the deploy                                                                                                                      |
| Notes / follow-ups | Closed by [#457](https://github.com/davidwkeith/workers/issues/457): added `/webmention-qa-source`; all 26 sender targets now deliver `200` (`test/23` needed its documented `/page` redirect entry point, see note above) |

## Recording the result

Fill in the **Result** table above first — date, tester, and notes — before
touching `status.json`. A `"passing"` entry with no corresponding filled-in
run here has no paper trail behind it.

Once the receiver matrix passes, record it in `conformance/status.json`:

```
packages["@dwk/webmention"].suites["webmention.rocks/receiver"]
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

Once the sender matrix has actually been run through `POST /webmention/send`
(Step 2/3, above), record it too:

```
packages["@dwk/webmention"].suites["webmention.rocks/sender"]
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

Leave `webmention.rocks/sender` at `"pending"` until this run has actually
happened — the trigger existing is not the same as the suite having been
run; don't mark it `"passing"` or `"failing"` on the strength of the trigger
alone.

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
  (§3.1.5 "SHOULD re-send on delete" — that's about the _sending_ side
  proactively notifying, which `@dwk/webmention` intentionally doesn't do;
  see `spec/packages/webmention.md`'s Known gaps). The receiving side
  re-verifying and dropping the mention is the mechanism that's supposed to
  work here.
