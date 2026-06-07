---
"@dwk/host-meta": minor
---

Add `@dwk/host-meta` — a Web Host Metadata (RFC 6415) discovery endpoint,
mountable at `/.well-known/host-meta` and `/.well-known/host-meta.json`.

- **`createHostMeta(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler. The host-wide document is
  config-supplied — a `webfingerUrl` that seeds an `lrdd` link templated to
  `…?resource={uri}`, plus optional static top-level `links` (and an optional
  `subject`/`properties`) — never read from the global environment. Fails loudly
  when neither a WebFinger URL nor any link is configured.
- **XRD ⇄ JRD content negotiation** from the one URL (RFC 6415 §3): XRD
  (`application/xrd+xml`) by default, JRD (`application/jrd+json`) when the client
  prefers it. Selection priority is the `?format=` override, then the
  `host-meta.json` path (RFC 7033 §10.1, always JRD), then the `Accept` header
  (JRD only when strictly preferred over XRD). The two representations are
  information-equivalent.
- The JRD link shaping is reused from `@dwk/webfinger` (the `Link` type);
  the XRD serializer (with `xsi:nil` for absent properties and nested
  `Title`/`Property` children, all XML-escaped) is the only new surface.
- Permissive CORS (`Access-Control-Allow-Origin: *`) and `Vary: Accept` on every
  response; `OPTIONS` preflight and `HEAD` supported, other methods `405`.
- Pure and **stateless**: no Durable Object, no D1, no required bindings; the
  request-invariant document is built once at construction and unit-tests under
  Node. Discovery events flow through the `@dwk/log` `Logger`/`Metrics` seams
  (`host-meta.served` with the negotiated `format`, `host-meta.rejected`).
