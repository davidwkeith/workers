---
"@dwk/webmention": minor
---

Recognize IndieWeb Vouch (indieweb.org/Vouch). A receiver may include an
optional `vouch` form field alongside `source`/`target`; during asynchronous
verification, once the mention itself verifies, the vouch URL is fetched and
checked for a link back to the target's hostname. The outcome is persisted on
the inbox record (`vouch: { url, verified }`, new nullable `vouch_url` /
`vouch_verified` columns, migrated additively on existing inboxes) — a vouch
that fails is stored distinctly from no vouch at all. Vouch never overrides
the primary source-links-to-target gate; a failed or absent vouch does not
reject the mention. Exports `verifyVouch` and `VouchResult`; `WebmentionJob`
and `VerifiedMention` gain an optional `vouch`. Part of
Anglesite/Anglesite#1597.
