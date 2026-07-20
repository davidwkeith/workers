# Pixelfed federation — QA runbook

Manual acceptance test for `@dwk/activitypub`'s Pixelfed interop (fediverse
interop tracking issue #273, phase 1: the typed object model / media-note
capability). This is the fillable, step-by-step companion to the terse
checklist in [`README.md`](./README.md#manual-run-pixelfed-target-pixelfed) —
run this doc, record results here, then update `status.json` per the last
section.

Pixelfed renders **only** posts carrying a media attachment; a text-only
`Note` never appears in a Pixelfed timeline. That's the one platform-specific
fact this whole test exists to prove `@dwk/activitypub` handles correctly —
everything else (alt text, content warnings, follow/like/reply) is standard
ActivityPub also exercised by the Mastodon and Fedify targets.

## Scope

- **In scope:** media-note publish → Pixelfed render (image, alt text,
  content warning); inbound `Follow`/`Like`/reply from a real Pixelfed
  instance.
- **Out of scope:** FEP-1b12 group participation (that's the Lemmy target),
  RFC 9421 / draft-cavage signature verification (covered by the Fedify
  target and its own test suite), and anything requiring a second `@dwk`
  actor (this test uses one live Pixelfed account against one deployed
  target).

## Environment

|                       |                                                               |
| --------------------- | ------------------------------------------------------------- |
| Target actor          | `https://conformance.dwk.io/users/conformance`                |
| WebFinger handle      | `@conformance@conformance.dwk.io`                             |
| Publish endpoint      | `POST https://conformance.dwk.io/users/conformance/publish`   |
| Auth                  | Bearer `ACTIVITYPUB_PUBLISH_TOKEN` (Cloudflare Worker secret) |
| Pixelfed instance     | _fill in, e.g. pixelfed.social_                               |
| Pixelfed test account | _fill in_                                                     |

Publish is confirmed enabled and working on this deployment as of the Fedify
conformance runs on 2026-07-20 (owner-publish `Note` succeeded in the
`fanout` case) — no additional setup should be needed before starting.

## Prerequisites

- [ ] A Pixelfed account on a live instance, logged in and ready to search/follow.
- [ ] A publicly reachable `https://` image URL you control (JPEG or PNG).
      `@dwk/activitypub` never hosts blobs itself — Pixelfed's server must be able
      to fetch this URL directly. A GitHub-raw URL, R2 public bucket URL, or any
      other publicly-hosted image works.
- [ ] The `ACTIVITYPUB_PUBLISH_TOKEN` value for the deployed target.

## Procedure

### Step 1 — Follow the actor from Pixelfed

1. From the Pixelfed account, search `@conformance@conformance.dwk.io`.
2. Follow it.
3. Confirm the follow was accepted:
   ```
   GET https://conformance.dwk.io/users/conformance/followers
   ```
   The Pixelfed account's actor IRI should appear in the collection.

- [ ] **Pass** — follower appears in the collection
- [ ] **Fail** — note what happened: ________________________________

### Step 2 — Publish a media note

```bash
curl -X POST https://conformance.dwk.io/users/conformance/publish \
  -H "Authorization: Bearer $ACTIVITYPUB_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "note",
    "content": "Testing Pixelfed federation from @dwk/activitypub (issue #273)",
    "summary": "Content warning test",
    "sensitive": true,
    "attachments": [
      {
        "type": "Image",
        "url": "<your publicly reachable image URL>",
        "mediaType": "image/jpeg",
        "name": "Descriptive alt text for the image"
      }
    ]
  }'
```

Expected: `200`/`202` with the created activity's id. Record the response
here: ________________________________

- [ ] **Pass** — request succeeded
- [ ] **Fail** — status code / body: ________________________________

### Step 3 — Verify rendering on Pixelfed

Check the Pixelfed timeline (or the account's profile grid) for the post
just published.

| Check               | Expected                                                                                                   | Pass/Fail |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| Post appears at all | Renders (proves the media-attachment requirement was met — a text-only post would silently not appear)     |           |
| Image renders       | The attached image displays                                                                                |           |
| Alt text            | Visible on the media (tap/hover the image, or Pixelfed's alt-text indicator) matches `attachments[0].name` |           |
| Content warning     | Post is concealed behind the `summary` text until clicked/tapped                                           |           |

Notes: ________________________________

### Step 4 — Like and reply from Pixelfed

1. From the Pixelfed account, **like** the published post.
2. **Reply** to it with any text.

Ask the session to check the target's inbox for both activities (the inbox
isn't a public endpoint, so this step needs to go through the deployed
target rather than a plain `curl`):

- [ ] **Pass** — `Like` activity recorded in the inbox
- [ ] **Pass** — reply (`Create`/`Note` with `inReplyTo`) recorded in the inbox
- [ ] **Fail** — note what's missing: ________________________________

## Result

|                             |                                  |
| --------------------------- | -------------------------------- |
| Overall result              | ☐ Passing / ☐ Failing            |
| Run date                    | ________________________________ |
| Tester                      | ________________________________ |
| Pixelfed instance + version | ________________________________ |
| Notes / follow-ups          | ________________________________ |

## Recording the result

Once every step above passes, record it in `conformance/status.json`:

```
packages["@dwk/activitypub"].suites["activitypub-federation"].targets.pixelfed
  = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }
```

If any step fails, leave the target at `"pending"` (or set `"failing"` with a
note in this doc under **Result** → Notes) and file a follow-up issue
referencing this run.

## Troubleshooting

- **`404 Not Found` on `/publish`** — `ACTIVITYPUB_PUBLISH_TOKEN` isn't set on
  the deployed target (publish is disabled when the secret is absent, not
  misconfigured). Confirm the secret exists before assuming a code bug.
- **`401 Unauthorized`** — wrong or missing bearer token; check for a stray
  `Bearer ` prefix duplication or trailing whitespace in the token value.
- **Post publishes but never appears on Pixelfed** — confirm the attachment
  really is present and its `url` is fetchable from the public internet
  (Pixelfed's server fetches it independently; a URL that only resolves on
  your own machine, e.g. `localhost`, will silently fail). Also confirm the
  follow from Step 1 actually reached `accepted` — Pixelfed only federates
  posts to accepted followers plus the public collection, and a post
  addressed to `Public` should still appear regardless, so a missing post
  more often points at the attachment fetch than at addressing.
- **Alt text or content warning missing** — some Pixelfed versions surface
  alt text only as a small "ALT" badge rather than inline text; check the
  badge before concluding it's absent.
