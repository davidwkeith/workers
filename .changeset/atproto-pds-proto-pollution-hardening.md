---
"@dwk/atproto-pds": patch
---

Harden DAG-CBOR decode and JSON⇄CBOR record conversion against prototype
pollution.

`decodeCbor` (map case), `jsonToCbor`, and `cborToJson` populated their result
objects with `obj[key] = …`. A `__proto__` key would then hit the inherited
`__proto__` setter and poison the object's prototype chain instead of becoming an
own data property. Records and CAR blocks are untrusted input, so this was
reachable from an XRPC `createRecord` body or an imported block.

All three now route key assignment through a small `assignKey` helper: a `__proto__`
key is written via a data descriptor (which sidesteps the setter) and every other
key uses plain assignment. The result keeps the standard `Object.prototype`
consumers expect while the prototype chain is never touched. Adds regression
tests for the decode and `jsonToCbor` paths.
