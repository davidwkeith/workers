---
"@dwk/server": patch
---

Now depends on the newly extracted `@dwk/cf-shims` (#381) via `workspace:*`
for its Cloudflare Workers binding shims, instead of owning them internally.
No behavior change — `@dwk/server`'s public exports are unchanged (now
re-exported from `@dwk/cf-shims`), and its full `phase*.integration.test.ts`
suite continues to pass unmodified as `@dwk/cf-shims`'s de facto integration
test. Split from the `@dwk/cf-shims` changeset because `@dwk/server` is
private and changesets rejects a changeset that mixes a private and a public
package.
