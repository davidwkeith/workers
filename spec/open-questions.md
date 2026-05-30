# Open questions / deferred decisions

These are tracked from [issue #1](https://github.com/davidwkeith/workers/issues/1)
§9. They are deliberately **out of scope for v1** but recorded so the
architecture does not foreclose them.

## 1. Solid-OIDC OP

v1 is **Resource Server only**, delegating token issuance to an existing
provider. Open: when do we own the OpenID Provider, and is it a separate
package or part of `@dwk/indieauth`?

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
