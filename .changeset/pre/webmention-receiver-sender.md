---
"@dwk/webmention": minor
---

Implement the Webmention receiver and sender, replacing the `501` stub.

- **Receiver** (`createWebmention`): synchronous `source`/`target` validation
  (valid `http(s)` URLs, `source` ≠ `target`, target under the receiver's
  control), `202 Accepted`, and enqueue for async verification. Fails loudly when
  the `WEBMENTION_QUEUE` binding is missing.
- **Async verification** (`createWebmentionQueueConsumer`): fetch the source,
  confirm it links to the target, and upsert (or remove) the mention in the
  inbox; retry on error.
- **Sender** (`sendWebmention` / `sendWebmentions`): spec-compliant endpoint
  discovery (`Link` header → HTML `<link>`/`<a rel=webmention>`, legacy rel
  accepted, relative URLs resolved) and `source`/`target` notification.
- **Inbox** (`createD1Inbox`): D1-backed store keyed on `(source, target)`,
  pluggable so a Solid Pod DO can back it instead.
