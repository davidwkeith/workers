---
"@dwk/activitypub": patch
---

The front door no longer follows a Durable Object redirect: a browser asking for an outbox object now gets its `302` to the post's `url`, where before the stub fetch followed it itself (a `404`, or a `522` on a Worker's own Custom Domain).
