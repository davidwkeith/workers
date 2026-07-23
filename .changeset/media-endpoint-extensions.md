---
"@dwk/micropub": minor
---

Implement the proposed media-endpoint extensions (#363, roadmap #354), gated
behind `extensions.proposed`: media `q=source` (newest-first listing and
by-URL lookup, `media` scope required), the `{ "url": ... }` upload response
body, and recoverable `action=delete`/`action=undelete` via an R2 `.trash/`
prefix with scope-pair enforcement and strict URL ownership validation.
Upload metadata is now always recorded in a new `micropub_media` D1 table
(best-effort while the group is off, fail-closed when on); the new
`mediaTrashRetentionDays` config (default 30) drives trash-row pruning, with
blob purge delegated to an R2 lifecycle rule.
