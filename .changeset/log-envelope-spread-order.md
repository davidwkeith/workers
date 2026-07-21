---
"@dwk/log": patch
---

`consoleLogger` now spreads the `level`/`event`/`time` envelope last, so a
caller's `fields` (or a composer's `base`) can no longer clobber it by
coincidentally using one of those names as a field key.
