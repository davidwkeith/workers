---
"@dwk/webdav": patch
"@dwk/solid-pod": patch
---

Fix four RFC 4918 conformance bugs surfaced by a real litmus run against
`conformance.dwk.io`:

- `MKCOL`/`PUT` with a missing intermediate collection silently succeeded
  instead of `409 Conflict` (litmus `mkcol_no_parent`/`put_no_parent`) —
  the WebDAV door was calling into `@dwk/solid-pod`'s LDP write path, which
  auto-vivifies missing ancestor containers by design; the WebDAV backend
  now checks the immediate parent exists first and throws `ResourceConflict`
  when it doesn't, leaving the LDP door's own auto-vivify behavior untouched.
- `MKCOL` over an existing plain resource silently succeeded instead of
  refusing (litmus `mkcol_over_plain`) — the existing-resource check only
  looked up the collection-path variant (with a trailing slash appended),
  missing a plain resource stored under the un-slashed name.
- `DELETE` of a resource that never existed silently succeeded instead of
  `404` (litmus `delete_null`) — the router didn't check existence before
  calling into the backend's remove.
