---
"@dwk/activitypub": patch
---

README: the "redirect back to the same URL" `key_unresolved` symptom is not only a bot-challenge page. On Cloudflare, a key fetch to a hostname in the Worker's own zone goes through the zone's SSL/TLS encryption mode even for a DNS-only record, and Flexible loops the origin's HTTP→HTTPS redirect; the fix is Full (strict) on the zone, not a `User-Agent`. Documents both causes next to the `activitypub.key_resolution.failed` log line.
