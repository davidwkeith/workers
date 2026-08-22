---
"@dwk/webmention": patch
---

fix(webmention): remove ambiguous quantifier pair in `Link` header parsing regex flagged by CodeQL as a polynomial ReDoS (`js/polynomial-redos`). The redundant `\s*` immediately before `(.*)$` overlapped with what `.` can already match, allowing crafted `Link` header values (attacker-controlled, fetched from a webmention source/target) to force excessive backtracking. Parameter-leading whitespace is still stripped by the per-parameter `rel` regex in `extractRel`, so behavior is unchanged.
