---
"@dwk/solid-pod": patch
---

Fix a container `PUT` persisting a client-forged `ldp:contains` triple. A
container's containment listing is entirely server-managed — clients never
legitimately send it — but `#putRdf` wrote every parsed body quad verbatim, so
a Turtle/JSON-LD container `PUT` that included a forged `ldp:contains` triple
had it persisted alongside the genuine, atomically-preserved containment. A
forged triple pointing at a resource that exists (or is later created)
elsewhere would then surface as a phantom membership in the container
listing. The container branch of `#putRdf` now strips any `ldp:contains`
quad whose subject is the container IRI from the client-supplied quads before
writing, since real containment is already preserved via `preserveWhere`.
