---
"@dwk/webmention": minor
---

Implement the Webmention §3.1.5 deleted-source re-send (the spec's last known gap, a SHOULD): `SendOptions` gains an opt-in `sentLog` that records every accepted notification (`createD1SentLog` — D1-backed, own `webmentions_sent` table, strongly consistent), and the new `resendForDeletedSource(source, options)` re-sends to every recorded target once the source serves `410 Gone`, so receivers re-verify and drop the mention. Accepted (or endpoint-less) re-sends clear their log row; failed ones keep it for a later retry. Two new observability events: `webmention.send.sent_log_write_failed` and `webmention.resend.completed`.
