---
"@dwk/microsub": patch
---

Drop the redundant in-batch `CREATE TABLE IF NOT EXISTS` from
`recordProof`'s D1 batch in the DPoP replay store — `init()` already creates
the schema, and `@dwk/micropub`'s twin implementation never repeats it in the
hot path. Purely a consistency fix; behavior is unchanged since the statement
was idempotent.
