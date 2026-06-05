# `@dwk/host-meta`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Web Host Metadata (RFC 6415)](https://www.rfc-editor.org/rfc/rfc6415) (+ [RFC 7033 §10.1](https://www.rfc-editor.org/rfc/rfc7033) JRD) |
| **Status** | proposed (honorable mention) — tracked in [#107](https://github.com/davidwkeith/workers/issues/107) |

`/.well-known/host-meta` (XRD) and `/.well-known/host-meta.json` (JRD):
host-wide resource-discovery metadata. Largely **superseded by**
[`@dwk/webfinger`](webfinger.md) for account discovery, but still expected by
some fediverse and OpenID software, which fetch `host-meta` to find the
**`lrdd`** (Link-based Resource Descriptor Document) template before falling
back to WebFinger. Filed for interop completeness, not as a near-term
recommendation.

## Worker vs. Anglesite (the static split)

Like [`@dwk/webfinger`](webfinger.md), host-meta is **borderline static**.
A single-identity site can have Anglesite emit a fixed
`/.well-known/host-meta` + `host-meta.json` and skip this package entirely.
The only thing a static host **cannot** do that justifies a Worker:

- **Content negotiation** between the XRD (`application/xrd+xml`) and JRD
  (`application/jrd+json`) representations from the one `/.well-known/host-meta`
  URL per RFC 6415 §3, plus the `?format=` override.
- A **dynamic `lrdd` template** whose `template` points at this Worker's
  WebFinger endpoint rather than a precomputed file.

If neither is needed, prefer the static Anglesite output and do **not** mount
this package.

## Functional requirements

- Export `createHostMeta(config)` returning the handler, mounted at
  `/.well-known/host-meta` and `/.well-known/host-meta.json`.
- Serve an **XRD** document by default and a **JRD** when the request prefers
  `application/jrd+json` (or `?format=json`); the two MUST be information-
  equivalent.
- Emit the configured top-level `Link` relations — at minimum an **`lrdd`**
  link whose `template` is the site's WebFinger URL
  (`https://example.com/.well-known/webfinger?resource={uri}`), plus any static
  `Link`s the operator configures (e.g. `author`, `license`).
- Reuse the JRD link-shaping helpers from [`@dwk/webfinger`](webfinger.md);
  the XRD serializer is the only new surface.

## Design constraints

- **Stateless** — no store, no bindings beyond config. The document is computed
  per request from config; nothing is persisted.
- MUST stay free of IndieWeb/Solid/fediverse assumptions in what it *requires*;
  the link set is entirely operator-supplied config.

## Bindings (declared `Env` fragment)

- None beyond config.

## Config

- `baseUrl` / host.
- The WebFinger endpoint URL for the `lrdd` template.
- Additional static top-level `Link` entries.

## Conformance / testing

- RFC 6415 (XRD) + RFC 7033 §10.1 (JRD) shape; round-trip equivalence between
  the two representations; interop with software that probes `host-meta`
  before WebFinger. See [conformance-and-testing.md](../conformance-and-testing.md).
