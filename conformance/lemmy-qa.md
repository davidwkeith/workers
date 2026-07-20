# Lemmy federation — QA runbook

Manual acceptance test for `@dwk/activitypub`'s Lemmy / threadiverse interop
(fediverse interop tracking issue #273, phases 2–3: FEP-1b12 group
participation and client publish shaping). This is the fillable, step-by-step
companion to the terse checklist in
[`README.md`](./README.md#manual-run-lemmy-target-lemmy) — run this doc,
record results here, then update `status.json` per the last section.

Unlike Mastodon/Pixelfed (where the actor talks to another actor directly),
Lemmy federates through a **community** — a `Group` actor that relays
(`Announce`s) member posts to its followers. This test exercises that whole
loop: follow a community, receive its relayed posts, post into it, reply, and
vote — and specifically re-verifies the vote-delivery fix from #324 (an
outbound `Like`/`Dislike` published without `audience` set silently never
reached the community at all before that fix).

## Scope

- **In scope:** FEP-1b12 group follow + `Announce`-unwrap + origin
  verification; posting a titled `Page` into a community; replying; voting.
- **Out of scope:** media attachments (that's the Pixelfed target), RFC 9421 /
  draft-cavage signature verification (covered by the Fedify target).
- **Important — no MCP handle resolution on this deployment.** The package
  supports resolving a `!community@instance` handle to its actor IRI (via
  `@dwk/webfinger`, wired into the shaped `/publish` endpoint's `audience`
  field, and separately exposed as the `activitypub_resolve` MCP tool), but
  `conformance.dwk.io` does not mount `@dwk/mcp`, and **the raw `/outbox`
  route never resolves handles at all** (only `/publish` does, for
  `audience`). Every IRI in this runbook is the full `https://` community
  actor URL, not a handle — resolve it yourself once (visit the community's
  page on the Lemmy instance and copy the URL) and reuse it throughout.

## Environment

|                     |                                                               |
| ------------------- | ------------------------------------------------------------- |
| Target actor        | `https://conformance.dwk.io/users/conformance`                |
| WebFinger handle    | `@conformance@conformance.dwk.io`                             |
| Outbox endpoint     | `POST https://conformance.dwk.io/users/conformance/outbox`    |
| Publish endpoint    | `POST https://conformance.dwk.io/users/conformance/publish`   |
| Auth                | Bearer `ACTIVITYPUB_PUBLISH_TOKEN` (Cloudflare Worker secret) |
| Lemmy instance      | _fill in, e.g. lemmy.ml_                                      |
| Lemmy test account  | _fill in_                                                     |
| Community actor IRI | _fill in, e.g. `https://lemmy.ml/c/<community>`_              |

Both `/outbox` and `/publish` are confirmed enabled and working on this
deployment as of the Fedify conformance runs on 2026-07-20 and the vote-
delivery fix in #324 — no additional setup should be needed before starting.

## Prerequisites

- [ ] A Lemmy account on a live instance, logged in.
- [ ] A community on that instance you're a moderator of, or at least willing
      to post/reply/vote in for testing (public communities are fine — this
      test doesn't need moderation rights, just activity in the community).
- [ ] The community's actor IRI (`https://<instance>/c/<community>`) — visit
      its page and confirm this is the URL, or `GET` it with
      `Accept: application/activity+json` to see its `id`.
- [ ] The `ACTIVITYPUB_PUBLISH_TOKEN` value for the deployed target.

## Procedure

### Step 1 — Follow the community

```bash
curl -X POST https://conformance.dwk.io/users/conformance/outbox \
  -H "Authorization: Bearer $ACTIVITYPUB_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "Follow", "object": "<community actor IRI>"}'
```

Expected: `201` with the created `Follow` activity. Ask the session to check
the target's `following` row for the community — it should reach `accepted`
(after the community's `Accept` arrives) with `actor_type = 'Group'`.

- [ ] **Pass** — `following` row exists, reaches `accepted`, `actor_type = 'Group'`
- [ ] **Fail** — note what happened: ________________________________

### Step 2 — Receive and unwrap community activity

Post something in the community from your Lemmy account (or wait for
existing activity), then ask the session to check the target's inbox.

Expected: the community's `Announce` arrives, and the **inner** activity is
unwrapped into its own inbox row carrying `relayed_by` = the community IRI,
with `verify_state` eventually advancing to `verified` (origin-verified via
the two-tier pipeline — content on the next alarm tick, votes in batched
sweeps).

- [ ] **Pass** — inner activity present with correct `relayed_by`, `verify_state` reaches `verified`
- [ ] **Fail** — note what's missing: ________________________________

### Step 3 — Post into the community

```bash
curl -X POST https://conformance.dwk.io/users/conformance/publish \
  -H "Authorization: Bearer $ACTIVITYPUB_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "page",
    "name": "Test post from @dwk/activitypub (issue #273)",
    "content": "<p>Testing Lemmy federation.</p>",
    "audience": "<community actor IRI>"
  }'
```

`audience` accepts either the full actor IRI or a `!community@instance`
handle here — this is the shaped `/publish` endpoint, which does resolve
handles, unlike the raw outbox used in the other steps.

Expected: `201`, and the post appears in the community (title intact) once
the community `Announce`s it back out to its members.

- [ ] **Pass** — post appears in the community with its title
- [ ] **Fail** — status code / what appeared instead: ________________________________

### Step 4 — Reply and vote

**Reply** (via `/publish`, same `audience` requirement as posting):

```bash
curl -X POST https://conformance.dwk.io/users/conformance/publish \
  -H "Authorization: Bearer $ACTIVITYPUB_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "note",
    "content": "Test reply from @dwk/activitypub",
    "inReplyTo": "<the community post'"'"'s object IRI>",
    "audience": "<community actor IRI>"
  }'
```

**Vote** (via the raw `/outbox` — `audience` is required here, per the fix in
#324; without it, delivery silently never reaches the community at all):

```bash
curl -X POST https://conformance.dwk.io/users/conformance/outbox \
  -H "Authorization: Bearer $ACTIVITYPUB_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "Like",
    "object": "<the community post'"'"'s object IRI>",
    "audience": "<community actor IRI>"
  }'
```

Swap `"type": "Like"` for `"Dislike"` to test a downvote instead/as well.

- [ ] **Pass** — reply appears in the community, threaded under the original post
- [ ] **Pass** — vote registers on Lemmy (post's score changes, or the vote
      shows in the target's `delivery` activity once resolved)
- [ ] **Fail** — note what's missing: ________________________________

## Result

|                          |                                  |
| ------------------------ | -------------------------------- |
| Overall result           | ☐ Passing / ☐ Failing            |
| Run date                 | ________________________________ |
| Tester                   | ________________________________ |
| Lemmy instance + version | ________________________________ |
| Notes / follow-ups       | ________________________________ |

## Recording the result

Fill in the **Result** table above first — date, tester, and instance —
before touching `status.json`. A `"passing"` entry with no corresponding
filled-in run here has no paper trail behind it.

Once every step above passes, record it in `conformance/status.json`:

```
packages["@dwk/activitypub"].suites["activitypub-federation"].targets.lemmy
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

If any step fails, leave the target at `"pending"` (or set `"failing"` with a
note in this doc under **Result** → Notes) and file a follow-up issue
referencing this run.

## Troubleshooting

- **`404 Not Found` on `/publish` or `/outbox`** — `ACTIVITYPUB_PUBLISH_TOKEN`
  isn't set on the deployed target (publish is disabled when the secret is
  absent). Confirm the secret exists before assuming a code bug.
- **`401 Unauthorized`** — wrong or missing bearer token.
- **Follow never reaches `accepted`** — check the target's `pending_accept`
  table; a community's inbox resolves off the critical path (from the DO's
  alarm), so there's a short delay before the `Follow` is even delivered.
  Give it a minute before concluding it's stuck.
- **Community posts don't unwrap / `verify_state` never advances** — the
  two-tier verification pipeline is `"tiered"` by default: content
  (`Create`/`Update`/`Delete`) verifies on the next alarm tick, but votes
  (`Like`/`Dislike`) are only verified in periodic **batched sweeps**, so a
  relayed vote can stay `pending` far longer than a relayed post before it's
  confirmed — this is expected, not a bug, unless it never resolves at all.
- **Vote never appears on Lemmy** — this is exactly the bug fixed in #324:
  confirm `audience` is set on the outbox `Like`/`Dislike` request. Without
  it, the vote is silently delivered only to your own followers (if any) and
  never reaches Lemmy — no error is returned, the request still `201`s.
- **Post/reply appears in the community with the wrong title, or not
  threaded correctly** — double check `name` is present (required for
  `kind: "page"`) and `inReplyTo` points at the post's **object** IRI (the
  `object.id` from the `Create` activity), not the `Create` activity's own
  `id`.
