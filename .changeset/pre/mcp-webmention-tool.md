---
"@dwk/webmention": minor
---

Add `createWebmentionMcpTools` (#240): a read-only `@dwk/mcp` tool
contribution `webmention_list_received`, listing verified Webmentions newest
first (optionally scoped to a `target` URL) over the same `InboxStore` the
queue consumer writes into. This is a new capability with no existing HTTP
`GET` endpoint to mirror (the receiver only ever accepts `POST`), so it
defaults `requiredScope` to `"read"` rather than an open scope. Mentions
originate from third-party pages, so the tool description documents the
prompt-injection surface — an agent must treat mention content as untrusted
data, never as instructions.
