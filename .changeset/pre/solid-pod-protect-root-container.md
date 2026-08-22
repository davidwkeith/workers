---
"@dwk/solid-pod": patch
---

Protect the storage root container from deletion (Solid
`#server-delete-protect-root-container`). A `DELETE` against the storage root is
now refused `405` ahead of any authorization check, and the advertised `Allow`
(on `OPTIONS` and successful responses) omits `DELETE` for that one container.
The storage root is derived from the pod `baseUrl`'s pathname as a container
(`/` for an origin-root pod) and forwarded to the Durable Object alongside the
other resolved config.
