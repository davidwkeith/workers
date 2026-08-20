# `@dwk/webmention`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Webmention](https://www.w3.org/TR/webmention/) |

Receives and sends Webmentions for the user's domain.

## Functional requirements

### Receiver

- Accept `source` and `target` parameters, **synchronously validating** before
  returning `202 Accepted` that `source` and `target` are valid URLs and that
  `target` is a resource under this receiver's control. Reject invalid/foreign
  targets up front — this is a spec requirement and prevents queue
  exhaustion / spam.
- **Verify the link asynchronously** via a queue (do not block the request on
  fetching and parsing the source for the `target` link).
- Store verified mentions to an **inbox** (D1, or the pod DO when composed with
  `@dwk/solid-pod`).

### Indie RSVP

- Recognize an **Indie RSVP**: a reply `h-entry` whose microformats2 carries
  `p-rsvp` (`yes` / `no` / `maybe` / `interested`) plus a `u-in-reply-to` aimed
  at the target, delivered as a Webmention (see the calendar/events thread,
  issue #167). During the same asynchronous verification pass, the receiver
  extracts the rsvp value when **both** halves are present — an unrecognized
  rsvp token, a missing `p-rsvp`, or an `in-reply-to` pointing elsewhere is
  stored as an ordinary mention — and persists it on the inbox record so a
  consumer can surface attendee state on the event.
- The `p-rsvp` value follows the mf2 `p-*` rule: a `value` attribute
  (`<data class="p-rsvp" value="yes">`, the recommended markup) wins, otherwise
  the element's text content is used.
- This is a **bounded** mf2 read done with the runtime's streaming
  `HTMLRewriter` — the two RSVP properties only — not a full Microformats2
  parser, which the runtime budget (`spec/non-functional-requirements.md`) rules
  out of the Worker bundle. The inbox schema gains a nullable `rsvp` column;
  pre-existing inboxes are migrated with an additive `ALTER TABLE`.

### Received-mention enrichment (issue #412)

- During the same asynchronous verification pass, read the source's
  microformats2 via the shared [`@dwk/mf2`](mf2.md) extractor (still no full
  parser in the bundle) and enrich the stored mention with what a consumer
  needs to render it: **interaction type**, **author**, **content**, and
  **published time**.
- **Scope:** the enrichment comes only from the one `h-entry` whose
  `u-in-reply-to` / `u-like-of` / `u-repost-of` / `u-bookmark-of` resolves to
  *our* target. Precedence when several match on the same entry:
  reply > repost > like > bookmark. A bare link with no matching entry is a
  plain `mention` with author/content **omitted**, never guessed from an
  unrelated entry on the page.
- **Content is untrusted UGC, sanitized at capture time, in the Worker,
  before it reaches D1:** the captured `e-content` HTML is reduced to
  `@dwk/mf2`'s `sanitizeHtml` allowlist
  (`p br em strong b i code pre blockquote ul ol li del s a`; all attributes
  stripped except a validated `a[href]`; `rel="ugc nofollow"` forced onto
  every surviving link — closing the SEO/spam-link vector) and truncated to
  ~500 text characters.
- **`publishedAt` is always populated:** the entry's declared `dt-published`
  when parseable, else the verification time.
- **Inbox schema:** additive nullable columns on the existing table (`id`,
  `interaction_type`, `author_name`, `author_url`, `author_photo`, `content`,
  `published_at`), same `ALTER TABLE` migration pattern as `rsvp`. `id` is a
  stable `wm-{hash}` derived from `(source, target)` with the same FNV-1a
  hash `@dwk/mf2` uses for its JF2 `_id`s — deterministic, so pre-migration
  rows re-derive it on read.
- `VerifiedMention` (inbox), `VerifyResult` (verification), and the
  `webmention_list_received` MCP tool output all surface the new fields.

### Vouch (indieweb.org/Vouch)

- Accept an optional `vouch` form field on receive, alongside `source`/
  `target`: a URL the sender is naming to establish trust. A `vouch` that is
  present but not a syntactically valid `http(s)` URL is **dropped silently**
  — the mention is still enqueued without it — never rejected. Vouch is a
  supplementary spam signal (a SHOULD), not a required parameter.
- During the same asynchronous verification pass, and **only once the
  mention itself has verified** (`source` genuinely links to `target`), fetch
  the vouch URL through the same SSRF-safe wrapper used for source
  verification and check whether it links anywhere under the target's
  **hostname** — not an exact-URL match like the target-link check, since the
  spec's wording is "links to the domain of the target." Only HTML vouch
  pages are scanned; any fetch failure, non-2xx status, non-HTML response, or
  oversized/unreadable body yields an unverified outcome. This check never
  throws and never blocks the mention itself.
- The outcome is persisted as three states, not two: no `vouch` field at all
  (no signal sent), `verified: true` (the vouch URL checks out), or
  `verified: false` (a vouch was attempted but did not check out — kept
  distinct from "no vouch," since a failed vouch attempt is a stronger spam
  signal than silence). Vouch never overrides or substitutes for the primary
  source-links-to-target verification gate.
- **Inbox schema:** additive nullable columns on the existing table
  (`vouch_url`, `vouch_verified`), same `ALTER TABLE` migration pattern as
  `rsvp`/the enrichment columns.
- `WebmentionJob` (queue message) and `VerifiedMention` (inbox) both gain an
  optional `vouch`; `verifyVouch`/`VouchResult` are exported alongside the
  existing `verifySource`/`VerifyResult`.

### Sender

- Discover Webmention endpoints for outbound links.
- Notify targets **on publish**.
- **Re-notify targets on delete (§3.1.5, a SHOULD).** The sender is stateless
  per call, so re-sending is opt-in via a `SentLog` (`sent-log.ts`): when one
  is supplied in `SendOptions`, every accepted notification is recorded
  (D1-backed default `createD1SentLog`, own `webmentions_sent` table, same
  strongly-consistent-store rule as the inbox). After the source is deleted
  and serving `410 Gone`, `resendForDeletedSource(source, options)` re-sends
  to every recorded target so each receiver re-verifies, finds the source
  gone, and drops the mention. Log rows are cleared for targets that accepted
  the re-send (or no longer declare an endpoint); failed targets keep their
  row for a later retry. Log writes are best-effort — a failed write never
  fails the send that succeeded.

### Federation handoff (documented config, not core code)

- Support emitting `h-card` / `h-entry` and pinging
  [Bridgy Fed](https://fed.brid.gy/) as **documented configuration**, not as
  core code paths.

## Bindings (declared `Env` fragment)

- A **queue** for async verification.
- Inbox storage: D1, or the `@dwk/solid-pod` DO namespace when composed.

## Config

- `baseUrl` / domain.
- Verification queue binding name.
- Inbox storage target.
- Optional federation (Bridgy Fed) settings.

## Conformance

- [webmention.rocks](https://webmention.rocks/) for both sender and receiver.
  See [conformance-and-testing.md](../conformance-and-testing.md).

### Known gaps

- None currently. The last one — the §3.1.5 deleted-source re-send — is now
  implemented on the publishing side (see the sender's opt-in `SentLog` +
  `resendForDeletedSource`); the receiving side already dropped a mention
  when asynchronous re-verification found the link gone (including a
  `410 Gone` source).
