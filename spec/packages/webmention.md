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

### Received-interaction enrichment

- During the same asynchronous verification fetch, parse the source with
  [`@dwk/mf2`](mf2.md)'s `parseHFeed` and look up `matchInteraction` against
  the target URL. This is still zero script-size cost — `@dwk/mf2` is
  `HTMLRewriter`-only, not a bundled parser, so it doesn't reopen the "no full
  Microformats2 parser" constraint above; it's a shared, broader extraction
  built the same way the RSVP read already is.
- A match enriches the stored mention with:
  - **`interactionType`** — `reply` / `repost` / `like` / `bookmark` from
    which "of" property matched (precedence reply > repost > like > bookmark
    when more than one implausibly matches), or `mention` when the source
    links to the target without any matching entry (no author/content
    attached in that case — it is not guessed from an unrelated entry on the
    page).
  - **`author`** — the matched entry's `p-author` / nested `h-card`
    (`name`/`url`/`photo`), when present.
  - **`content`** — the matched entry's `e-content`, already sanitized by
    `@dwk/mf2`'s `sanitizeContentHtml` (untrusted third-party HTML; see
    [mf2.md](mf2.md) for the allowlist and the `rel="ugc nofollow"` link
    treatment), truncated to ~500 characters.
  - **`published`** — the entry's `dt-published` when declared, otherwise the
    verification timestamp (a plain reply rarely marks up an explicit
    published time; the field must still always be present downstream).
- The inbox schema gains nullable columns for each of the above plus a stable
  `id` (a `wm-{hash}` derived from `(source, target)`, same FNV-1a hash
  `@dwk/mf2`'s JF2 layer uses for its own entry `_id`s) — an additive
  `ALTER TABLE` migration, same pattern as `rsvp`.
- This is the data Anglesite's `ReceivedInteraction` snapshot (its C.3
  canonicality decision) needs to render real replies/likes/reposts instead of
  anonymous `(source, target)` pairs; see
  [Anglesite-app#362](https://github.com/Anglesite/Anglesite-app/issues/362).

### Sender

- Discover Webmention endpoints for outbound links.
- Notify targets **on publish**.

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

- **Deleted-source re-send (§3.1.5, a SHOULD).** When a previously sent source
  is later deleted, the sender does not re-send a Webmention so the receiver can
  drop the mention. This is an intentional scope limit: the receiver already
  removes a mention when asynchronous re-verification finds the link gone
  (including a `410 Gone` source), so the inbox stays correct on the receiving
  side. Re-sending on delete from the publishing side is deferred.
- **`content` formatting fidelity.** `@dwk/mf2`'s capture-time sanitizer keeps
  a fixed inline-formatting allowlist (see [mf2.md](mf2.md)); images, headings,
  and tables in a received reply are dropped rather than preserved. Deliberate
  scope limit, tracked in
  [#413](https://github.com/davidwkeith/workers/issues/413).
