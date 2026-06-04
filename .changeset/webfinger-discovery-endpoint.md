---
"@dwk/webfinger": minor
---

Add `@dwk/webfinger` — a WebFinger (RFC 7033) discovery endpoint, mountable at
`/.well-known/webfinger`.

- **`createWebfinger(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler. The `resource → JRD`
  mapping is config-supplied — a static `resources` map, a dynamic `resolve`
  function, or both (the map is consulted first) — never read from the global
  environment. Fails loudly when neither is configured.
- **Spec-correct dispatch:** `resource` absent → `400`; a resource this server
  does not control → `404`; a match → `200` with an `application/jrd+json` body
  whose `subject` echoes the queried URI (any scheme, for fediverse interop).
- **`rel` filtering** (repeatable) scopes the `links` array; `aliases` and
  `properties` are unaffected. Permissive CORS (`Access-Control-Allow-Origin: *`)
  on every response per §10.2; `OPTIONS` preflight and `HEAD` supported, other
  methods `405`.
- Pure and **stateless**: no Durable Object, no D1, no required bindings; unit-
  tests under Node. Discovery events flow through the `@dwk/log`
  `Logger`/`Metrics` seams with the queried `resource` reduced to its host.
