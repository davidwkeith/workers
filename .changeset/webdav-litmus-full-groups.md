---
"@dwk/webdav": minor
"@dwk/solid-pod": patch
---

litmus conformance (issue #467): `basic`, `copymove`, and `locks` now pass
16/16, 13/13, and 41/41 against the composed conformance target.

- `MKCOL` with a trailing slash over an existing plain resource now 405s —
  neon's `ne_mkcol()` always appends a slash, so the previous un-slashed-only
  existence check let `mkcol_over_plain` create a collection alongside the
  plain resource.
- WebDAV collection `DELETE` now acts as `Depth: infinity` (RFC 4918 §9.6.1),
  removing the whole subtree instead of refusing non-empty collections with
  409; the Solid door keeps its LDP refuse-on-non-empty semantics. litmus's
  own `begin` fixture depends on this to clear a previous run's leftovers.
- The `If:` header is now parsed as the full (bounded) RFC 4918 §10.4 grammar
  — multiple OR'd lists, resource tags, `Not`, `DAV:no-lock` — and genuinely
  evaluated as a precondition (412 when no list holds, including a lock token
  that names no live lock), with lock enforcement counting only
  positively-named tokens as submitted.
- Shared write locks: any number coexist, any one of their tokens admits a
  write, and an exclusive request against them conflicts.
- The XML parser rejects the invalid `xmlns:prefix=""` declaration (400, litmus
  `propfind_invalid2`) and resolves a legal `xmlns=""` un-declaration to *no*
  namespace so no-namespace property names serialize legally.

The `props` group still fails 8/30 cases, all on dead-property storage —
excluded from v1 by spec §4 ("PROPPATCH of arbitrary dead properties is out
of scope") — which is the remaining blocker for a fully green litmus run.
