---
"@dwk/webdav": minor
"@dwk/solid-pod": minor
---

Store WebDAV dead properties (RFC 4918 §4) in the pod DO's SQLite, closing the
last litmus `props` failures (issue #467). `@dwk/webdav` gains `PropertyStore`
and a `properties: DeadPropertyApi` port on the `WebdavBackend` seam; PROPPATCH
now applies set/remove in document order and atomically (a protected live
property fails 403 and drags the rest to 424, persisting nothing), and PROPFIND
returns stored dead properties for named-prop, `allprop`, and `propname`
requests — including no-namespace names, astral-plane values, and namespaced
element values. `@dwk/solid-pod` wires the store through the pod DO: properties
travel with COPY/MOVE and are dropped on DELETE from either door (WebDAV or
Solid LDP).
