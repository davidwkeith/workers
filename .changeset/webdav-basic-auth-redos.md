---
"@dwk/webdav": patch
---

Fix a polynomial-regex-ReDoS finding (CodeQL `js/polynomial-redos`, alert #11)
in `parseBasicAuthorization`: `/^basic\s+(.+)$/i` had `\s+` immediately
followed by `(.+)$`, and since `\s` is a subset of what `.` matches, the two
quantifiers were ambiguous about how to split the client-supplied
`Authorization` header between them — the same shape already fixed in
`@dwk/webmention`'s `parseLinkHeader` (#436). Replaced the combined regex with
a plain `String.prototype.search`/`slice` split on the first whitespace run,
which is unambiguous by construction. Behavior is unchanged, confirmed by the
existing `parseBasicAuthorization` test suite.
