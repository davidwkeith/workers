---
"@dwk/solid-pod": patch
---

Fix Solid Protocol / WAC conformance gaps in the resource handler. Emit the
`WAC-Allow` header on `GET`/`HEAD` responses advertising the authenticated
agent's and the public's granted modes (WAC §5.3.5), with `write` implying
`append`. Return `422` for N3 Patch document-constraint violations as Solid
§5.3.1 mandates — a missing `solid:InsertDeletePatch` type triple, blank nodes
in the inserts/deletes formulae, more than one `solid:where`/`inserts`/`deletes`
statement, and template variables not bound by `where` are now rejected with
`422` instead of `400`/`409`, while `409` is reserved for binding/state
outcomes (`no_match`/`ambiguous_match`/`delete_not_found`). Add the `Allow`
header to successful responses (Solid `#server-allow-methods`).
