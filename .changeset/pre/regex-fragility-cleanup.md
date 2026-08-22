---
"@dwk/webmention": patch
"@dwk/solid-pod": patch
---

Replace fragile regexes with plain string handling where it is clearer and
safer:

- `@dwk/webmention`: add a shared `isHtmlContentType` helper that compares the
  `Content-Type` essence (the part before any `;` parameters) instead of a
  loose `text/html|application/xhtml+xml` substring match, and use it in both
  source verification and endpoint discovery. The `javascript:`/`file:` guard
  in the sender now compares `URL.protocol` directly rather than via regex.
- `@dwk/solid-pod`: the access-token `typ` normalization strips the
  `application/` prefix with `startsWith`/`slice`. The LDP container `Link`
  detection now ties the `rel="type"` parameter to the container-type URI
  within the same link-value, so a stray `rel="type"` on one link can no longer
  combine with an unrelated container URI on another to falsely mark a POST as
  a container.
