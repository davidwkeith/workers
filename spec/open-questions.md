# Open questions / deferred decisions

These are tracked from [issue #1](https://github.com/davidwkeith/workers/issues/1)
§9. They are deliberately **out of scope for v1** but recorded so the
architecture does not foreclose them.

## 1. Solid-OIDC OP — resolved

v1 was **Resource Server only**, delegating token issuance to an existing
provider. **Resolved:** the OP is now a **separate package**,
[`@dwk/solid-oidc`](packages/solid-oidc.md), that **composes `@dwk/oauth`'s
primitives** rather than growing inside `@dwk/indieauth` — the direction
`spec/packages/oauth.md` anticipated. Its first increment implements the
authorization-code + PKCE (S256) + DPoP flow issuing ES256-signed WebID access
tokens a `@dwk/solid-pod` accepts (see the package spec for the deferred
follow-ups: client-document validation, refresh tokens, DCR/PAR/introspection
wiring, DPoP-nonce).

## 2. Pod write ceiling

The DO-per-pod model is single-threaded — fine for personal pods, a real cap
for shared / org pods. **Sharding-within-pod is rejected for v1** because it
breaks containment + WAC invariants. Revisit only via container-subtree
boundaries if a real need appears.

## 3. Provisioning split

Confirm that `wrangler`-config generation + deploy orchestration live in
**Anglesite**, with the `@dwk` packages exposing only declarative requirements
(bindings + config schema). This is the current assumption throughout the
specs.

## 4. JSON-LD on the edge — RESOLVED

N3.js does not parse/serialize JSON-LD, yet JSON-LD is a required Solid
content-negotiation format and `jsonld.js` is too heavy for the Worker
script-size budget.

**Resolution:** [`@dwk/rdf`](packages/rdf.md) ships its **own dependency-free
JSON-LD ⇄ RDF converter** (no `jsonld.js`, no Comunica — zero added bytes beyond
N3.js), implementing a pragmatic subset of JSON-LD 1.0 toRDF/fromRDF. Parsing
covers inline contexts (term/prefix/CURIE expansion, `@vocab`, `@base`,
`@language`, expanded term definitions, `@type` coercion, `@list`, `@graph`,
`@reverse`); serialization emits expanded/flattened form that round-trips
losslessly. **Remote (URL) contexts, framing, and JSON-LD 1.1-only features are
out of scope for v1** and throw or are ignored. The full supported subset and
its limitations are documented in
[`packages/rdf/README.md`](https://github.com/davidwkeith/workers/blob/main/packages/rdf/README.md).
Widening the subset later does not change the public API.

## 5. WebDAV façade for OS-native pod access — RESOLVED (implemented)

OS file managers (Finder, Explorer, GNOME/KDE, iOS Files) speak **WebDAV
(RFC 4918)** but not Solid/LDP, so the [`@dwk/webdav`](packages/webdav.md) façade
lets a user mount their pod as a network drive with zero install. The verbs are a
thin layer over `@dwk/store` + the `solid-pod` DO; the load-bearing decisions were
the **auth bridge** (scoped, hashed-at-rest *app passwords* over Basic-HTTPS,
since no OS client can do DPoP) and **Class 2 locking** (lock state in DO SQLite).
All of it has landed: the protocol core (XXE-safe XML, scoped app passwords,
`Content-Type`/`If` header parsing), the `createWebdav` Class 2 verb router with
locking, the per-pod Durable Object integration (`createSolidPodWebdav` in
`@dwk/solid-pod`), `COPY`/`MOVE` (resource + collection), the owner-gated
app-password mint/list/revoke endpoint, and per-resource size + mtime in
`@dwk/store` so PROPFIND metadata is real. The remaining increment is a hosted
litmus conformance run against a deployed Worker. Spec in
[`packages/webdav.md`](packages/webdav.md). Tracked in
[#169](https://github.com/davidwkeith/workers/issues/169).

## 6. Email endpoint package (JMAP)

A review of Cloudflare's
[agentic-inbox](https://github.com/cloudflare/agentic-inbox) (an email client
built on Email Routing → per-mailbox Durable Object SQLite → R2 attachments)
showed its storage layer is almost exactly this repo's per-entity DO pattern —
but its client API is proprietary REST, so the code itself doesn't fit the
"packages named for the standard" taxonomy. The standards-native shape of the
same idea is **JMAP** ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) core ·
[RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) mail): Email Routing
ingress, a per-mailbox DO built on [`@dwk/store`](packages/store.md), R2 for
blobs/attachments, JMAP as the client API, and the Email Service binding for
outbound send — a textbook endpoint package (`@dwk/jmap`) by the existing
conventions.

**Deferred, not planned.** JMAP is an epic on the scale of
[`@dwk/atproto-pds`](packages/atproto-pds.md), not an incremental package, and
outbound send depends on Cloudflare's still-young Email Service. Two smaller
increments are worth considering first if email pressure appears: a
receive-only ingest (Email Routing → DO, no JMAP client API), and a
JMAP→jf2 bridge that surfaces a mailbox as a
[`@dwk/microsub`](packages/microsub.md) channel so email lands in the same
unified inbox as feeds and notifications. The agent-facing half of the
agentic-inbox review is tracked separately as the MCP surface
([packages/mcp.md](packages/mcp.md),
[#240](https://github.com/davidwkeith/workers/issues/240)); any embedded AI
agent stays at the app layer (Anglesite) per §3.

---

## Reference links

- **Solid Protocol & specs:** <https://solidproject.org/TR/protocol>
- **Community Solid Server** (reference impl): <https://github.com/CommunitySolidServer/CommunitySolidServer>
- **IndieWeb specs:** [IndieAuth](https://indieauth.spec.indieweb.org/) ·
  [Micropub](https://micropub.spec.indieweb.org/) ·
  [Webmention](https://www.w3.org/TR/webmention/)
- **Bridgy Fed** (federation): <https://fed.brid.gy/>
- **N3.js:** <https://github.com/rdfjs/N3.js>
- **Cloudflare:** [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency) ·
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits) ·
  [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits)

> Some appendix links in issue #1 were left as bare placeholders; the URLs above
> are the canonical specs they refer to. Correct any that drift from the
> owner's intent.
