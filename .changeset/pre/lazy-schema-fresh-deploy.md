---
"@dwk/indieauth": patch
"@dwk/micropub": patch
"@dwk/microsub": patch
---

Create D1 schema lazily so a fresh deploy no longer 500s (#291, #292). The
IndieAuth code/token store, the Micropub post store, and the Micropub/Microsub
DPoP replay stores previously created their tables only in an `init()` that no
handler ever called, so a consumer composing these packages against a brand-new
D1 hit `no such table` on the first authorization/token/publish request, and —
because DPoP replay-checking is on by default — every authenticated
create/update/delete `500`ed permanently.

Each store now materialises its schema lazily on first use (the same
`ensureSchema` pattern the webmention/websub/microsub stores already use), with
the cached init promise cleared on failure so a transient D1 error doesn't wedge
the store. The IndieAuth RFC 8707 `resource`-column migration now runs on that
lazy path too, so it actually reaches consumer databases. No separate migration
step is required.
