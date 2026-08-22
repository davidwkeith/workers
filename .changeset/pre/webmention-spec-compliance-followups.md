---
"@dwk/webmention": patch
---

Tighten Webmention spec compliance on three audit follow-ups (issue #96).

- **Exact-match non-HTML source verification (§3.2.2).** `sourceLinksTo` no
  longer treats a non-HTML body with a loose `body.includes(target)` substring
  check, which over-matched the target appearing inside a longer URL
  (`…/target/extra`), as a prefix (`…/post` inside `…/posting`), or buried in
  prose. A JSON (`application/json` or `+json`) body is now parsed and must carry
  a string value exactly equal to the target; any other body must contain the
  target as a standalone URL token (boundary-checked), not a bare substring. The
  HTML path already did proper resolved-link exact matching.
- **Robust legacy `rel` matching (sender discovery).** Endpoint discovery matched
  the legacy rel with `startsWith("http://webmention.org")`, which also accepted
  look-alike hosts like `http://webmention.org.evil.example/`. It now normalizes a
  candidate rel through `URL` and compares against the canonical legacy endpoints
  `http://webmention.org/` and `http://webmention.org/webmention` — so a
  look-alike host (or wrong scheme) is rejected, while a commonly omitted trailing
  slash (`http://webmention.org`) still matches.
- **Receiver `Content-Type` validation (§3.1.3).** The receiver now requires an
  `application/x-www-form-urlencoded` body and rejects other encodings (e.g.
  `multipart/form-data`) with `400` instead of accepting whatever
  `Request.formData()` parses.

The deleted-source (HTTP 410) re-send on the sender (§3.1.5, a SHOULD) remains an
intentional scope limit and is now recorded as a known conformance gap in the
package spec; the receiver already drops a mention when re-verification finds the
link gone.
