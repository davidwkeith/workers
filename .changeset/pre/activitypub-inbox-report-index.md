---
"@dwk/activitypub": patch
---

Add composite indexes on the `inbox` table so `GET <actor>/reports` and the
`activitypub_list_inbox` MCP tool no longer full-table-scan: `idx_inbox_type_resolved_seq
ON inbox (type, resolved_at, seq)` backs `#listReports`'s `Flag`/unresolved
filter and `idx_inbox_removed_seq ON inbox (removed_at, seq)` backs
`#listInbox`'s tombstone filter, both covering the `ORDER BY seq DESC` too
(#501).
