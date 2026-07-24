---
"@dwk/micropub": patch
---

Fix a prototype-pollution vulnerability (CodeQL alert #5) across all of
`mf2.ts`'s attacker-reachable object-key assignments, not just the
form-encoded path: a Micropub request with a property/filter named
`__proto__` (or `constructor`/`prototype`) reached a plain
`obj[key] = value` assignment, which for those literal strings invokes an
accessor instead of setting an own property.

- `parseFormBody` (form-encoded `create`): `__proto__[x]` reached a
  double-dereference (`(nested[key] ??= {})[sub] = value`) that read and then
  wrote through the shared, global `Object.prototype` — corrupting every
  other request the Worker isolate serves afterward. This was the original,
  most severe vector.
- `parseJsonBody` and `asPropertyMap` (used by `parseUpdateOperations` for
  JSON `create`/`replace`/`add`/`delete`): a `"__proto__"` property/JSON key
  reassigned the _result_ object's own prototype (`Object.getPrototypeOf(properties) === Array.prototype`
  was reachable), a narrower but still real type-confusion bug — JSON.parse
  itself is safe (it creates an own `"__proto__"` data property), but
  copying that key into a fresh object literal via `obj[key] = value` is not.
- `applyUpdate` and `sourceView`: the same pattern, reachable via update
  operations and via the `?properties[]=` query-string filter on `q=source`
  respectively.

Fix: a shared `setOwn` helper (plus explicit skip-and-continue where a key
is also read before being written) rejects `__proto__`/`constructor`/
`prototype` at every one of these assignment sites, alongside the existing
form-key gate. Extended `mf2.test.ts` to cover `parseJsonBody`,
`parseUpdateOperations`/`applyUpdate`, and `sourceView` with the same attack
shape, asserting the affected object's own prototype/properties are
unaffected.
