---
"@dwk/webmention": minor
"@dwk/indieauth": minor
---

Scan HTML with the Workers runtime's streaming `HTMLRewriter` instead of regex
tag matching. A real tokenizer correctly ignores elements inside comments,
handles attribute quoting, and never mistakes `data-href` for `href` — without
pulling a parser into the bundle (`HTMLRewriter` is built into the runtime).

Because `HTMLRewriter` is async and `workerd`-bound, the affected helpers are
now async (and exercised under the Workers test pool rather than bare Node):

- `@dwk/webmention`: `findWebmentionEndpoint`, `extractLinks`, and
  `sourceLinksTo` now return `Promise`s. The internal `stripComments`,
  `matchTags`, `getAttr`, and `resolveDocumentBase` regex helpers are replaced
  by a single `scanElements` primitive.
- `@dwk/indieauth`: `parseRelMeLinks` and `relMeLinksBack` now return
  `Promise`s; the regex `rel=me` tag/attribute scanning is gone.

Behaviour (including the webmention.rocks discovery conformance cases) is
unchanged; only the helper signatures became async.
