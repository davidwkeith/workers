---
"@dwk/wac": patch
"@dwk/solid-pod": patch
---

`evaluateAccess`'s second parameter is now a single `AclResource` (the
effective ACL) instead of an `AclResource[]` chain of which only the first
entry was ever consulted — the array shape implied a multi-entry walk that
never happened. Callers passing `[acl]` now pass `acl` directly.

Also documents (with a regression test) that a subject granting
`acl:mode`/`acl:agent`/etc. without an explicit `rdf:type acl:Authorization`
triple is not treated as an authorization — a conscious, fail-closed choice,
not an oversight.
