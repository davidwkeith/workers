---
"@dwk/solid-pod": patch
---

Fix a cluster of LDP / content-negotiation conformance gaps (issue #37):

- **`406 Not Acceptable` is now returned** when an `Accept` header is present but
  lists nothing the server can serialize (e.g. `Accept: application/pdf` on an
  RDF resource). `negotiateMediaType` distinguishes "no `Accept` / `*/*`"
  (→ Turtle default) from "present but unacceptable" (→ `null`, mapped to `406`);
  it previously fell through to Turtle for any unmatched type.
- **Auxiliary resources no longer leak through container listings.** `.acl` and
  `.meta` documents are no longer added to a container's `ldp:contains`, so a
  requester with container `Read` can no longer discover the existence/paths of
  ACL documents.
- **`If-None-Match` now honors lists and weak validators** per RFC 7232 §3.2.
  A header is parsed as a comma-separated list and compared with the weak
  comparison function (the `W/` prefix is ignored), so `If-None-Match: "a", "b"`
  and `W/"…"` correctly produce `304`, restoring conditional-GET caching.
- **`Accept-Post` advertises concrete types** (`text/turtle, application/ld+json,
*/*`) instead of a bare `*/*`.
