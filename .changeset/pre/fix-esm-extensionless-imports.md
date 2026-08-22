---
"@dwk/indieauth": patch
"@dwk/micropub": patch
"@dwk/webmention": patch
"@dwk/dpop": patch
"@dwk/log": patch
---

Fix: emit explicit `.js` extensions on relative imports so the published ESM
packages resolve under Node's ESM loader.

The packages were built with `moduleResolution: "Bundler"`, which let source
files omit extensions on relative specifiers (`export { createWebmention } from
"./handler"`). `tsc` preserves specifiers verbatim, so the published
`dist/index.js` re-exported extensionless paths that Node's ESM loader cannot
resolve — `import("@dwk/webmention")` failed with `ERR_MODULE_NOT_FOUND` (only
a bundler like esbuild/wrangler papered over it). Relative specifiers across the
monorepo now carry explicit `.js` extensions, and `tsconfig.base.json` moves to
`module`/`moduleResolution: "NodeNext"` so the compiler enforces extensions and
this cannot silently regress.
