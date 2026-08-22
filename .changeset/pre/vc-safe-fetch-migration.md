---
"@dwk/vc": minor
---

Move the status-list SSRF-safe fetch onto the shared `@dwk/safe-fetch`
package instead of a package-local copy (no behavior change). Also close a
gap where `createDidWebResolver`'s DID-document fetch had **no** SSRF
protection or timeout at all (#215) — it now goes through the same
`safeFetch` guardrails as the status-list fetch. `DidWebResolverOptions.fetch`
widens from a narrow `{ ok, status, json() }` shape to a full `Response`-
returning `FetchLike`, matching `@dwk/safe-fetch`'s type — a minor bump for
any caller supplying a custom fetch implementation.
