---
"@dwk/micropub": patch
---

Fix a prototype-pollution vulnerability (CodeQL alert #5) in
`parseFormBody`'s form-encoded body parser: a Micropub `create` request with
a field named `__proto__[x]` (or `constructor[x]`/`prototype[x]`) reached a
plain `obj[key] = value` assignment, which for the literal string
`"__proto__"` invokes the object's `[[Prototype]]` accessor instead of
setting an own property — mutating the shared, global `Object.prototype` for
the lifetime of the Worker isolate, corrupting every other request it serves.

Fix: reject `__proto__`/`constructor`/`prototype` as a property key or
sub-key at the same gate that already filters reserved form keys
(`access_token`/`action`/`url`/`h`), before either ever reaches an object
assignment. Added `mf2.test.ts` covering the attack plus the existing nested/
multi-valued property behavior, so `Object.prototype` is asserted unaffected
after a crafted request.
