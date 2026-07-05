---
"@dwk/activitypub": patch
"@dwk/vc": patch
---

Harden two unauthenticated/attacker-controlled fetch paths found in a
Cloudflare Workers best-practices review:

- `@dwk/activitypub`: the inbox and owner-publish endpoints now cap the
  request body (2 MB) before buffering it, rejecting oversized bodies with
  413 instead of letting an unauthenticated federation peer control how much
  memory the Worker allocates.
- `@dwk/vc`: verifying a foreign `credentialStatus.statusListCredential` URL
  (attacker-controlled, taken from the credential under verification) now
  goes through an SSRF-safe fetch — https-only, private/reserved hosts
  blocked (previously only the scheme was checked), a bounded timeout, and a
  capped response body read — instead of an unguarded `fetch`.
