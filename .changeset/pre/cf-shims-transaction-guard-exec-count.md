---
"@dwk/cf-shims": patch
---

Parity fixes ported from the `@dwk/deno-host` review (#403): nested
`transactionSync`/`transaction` calls now fail loudly with a clear "does
not support nesting" error instead of the inner `BEGIN`/`ROLLBACK` silently
discarding the outer transaction's writes and obscuring the original error;
and `exec()`'s reported `D1ExecResult.count` no longer counts semicolons
inside string/comment literals.
