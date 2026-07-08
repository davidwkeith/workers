# `@dwk/mcp`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Used by** | tool contributions from the endpoint packages (`@dwk/micropub`, `@dwk/microsub`, `@dwk/webmention` first; `@dwk/solid-pod`, `@dwk/ldn`, `@dwk/activitypub` later) |
| **Standard** | [Model Context Protocol](https://modelcontextprotocol.io/specification) (JSON-RPC 2.0 over Streamable HTTP) |
| **Status** | **proposed — spec sketch, not implemented.** Tracked in [#240](https://github.com/davidwkeith/workers/issues/240) |

> **This is a pre-implementation sketch.** The load-bearing decisions below
> (tools-only subset, auth bridge, side-effect posture) should be reviewed on
> [#240](https://github.com/davidwkeith/workers/issues/240) before any code
> lands.

An MCP (Model Context Protocol) server surface for the composed Worker, so an
AI agent authorized by the owner can **operate the infrastructure the owner
already self-hosts**: publish via Micropub, read the Microsub timeline, list
received Webmentions, and eventually read/write the pod and the
LDN/ActivityPub inboxes.

The idea is borrowed from Cloudflare's
[agentic-inbox](https://github.com/cloudflare/agentic-inbox) (an email client
exposing the mailbox at `/mcp`); this cohort's version fixes its documented
weak point — a single network-level trust boundary with no per-resource
authorization — by issuing **scoped, DPoP-bound tokens** through the auth
stack this repo already ships.

## Why a cross-standard lib

MCP is an open, versioned protocol with no IndieWeb/Solid semantics of its
own, exactly like `@dwk/oauth` and `@dwk/http-signatures`. The lib therefore
carries **zero knowledge of any cohort standard** (hard constraint for
cross-standard libs): it implements the wire protocol and a tool registry,
and the per-standard tool definitions live in the endpoint packages — the
same adapter rule as `@dwk/calendar` (`h-event → CalendarEvent` lives in the
endpoint package, never the lib).

## Functional requirements

- **Protocol core (v1 = tools only).** JSON-RPC 2.0 request/response +
  batch handling and the MCP lifecycle over **Streamable HTTP**:
  `initialize` (capability + protocol-version negotiation), `ping`,
  `tools/list`, `tools/call`. Resources, prompts, sampling, elicitation, and
  stdio transport are **out of scope for v1**; the capability object simply
  omits them, which is protocol-legal.
- **Dependency-free.** No `@modelcontextprotocol/sdk` — the v1 subset is
  small, the official SDK is Node-shaped and heavy against the Worker
  script-size budget, and the repo already has precedent for this call
  (`@dwk/rdf`'s own JSON-LD subset instead of `jsonld.js`).
- **Handler factory.** `createMcp(config): (request, env, ctx) =>
  Promise<Response>`, mountable under a path prefix (conventionally `/mcp`)
  per the [composition contract](../composition-contract.md). No global env
  reads; multiple instances per Worker must work.
- **Tool registry.** `config.tools` is a flat list of tool definitions
  supplied by the composing developer. Endpoint packages export factories —
  e.g. `@dwk/micropub` adds `createMicropubMcpTools(config)` — whose returned
  definitions carry the JSON Schema `inputSchema`, MCP **annotations**
  (`readOnlyHint`, `destructiveHint`, …), a required scope string, and a
  handler closure over the package's existing machinery.
- **Auth bridge.** MCP authorization is OAuth 2.1-shaped, so reuse what the
  repo owns rather than inventing anything: bearer + **DPoP-bound** access
  tokens validated via [`@dwk/dpop`](dpop.md), introspection/metadata via
  [`@dwk/oauth`](oauth.md), issuance by [`@dwk/indieauth`](indieauth.md).
  `401` responses advertise the protected-resource metadata
  (RFC 9728-style) so MCP clients can discover the authorization server.
  Every `tools/call` is checked against the token's granted scopes ∩ the
  tool's required scope — **per-tool least privilege, not a perimeter**.

## Design constraints

- **Plain-data core.** The JSON-RPC layer, lifecycle state machine, and
  registry dispatch take parsed messages in and return plain objects; they
  MUST unit-test under Node without a Workers runtime. Only the thin
  `createMcp` HTTP shell touches `Request`/`Response`.
- **Stateless by default.** Streamable HTTP sessions (`Mcp-Session-Id`) and
  SSE resumability are **not** offered in v1; each POST is independent, which
  suits the stateless-front-door architecture. If session state is ever
  added, it lives in a strongly-consistent store — **never KV**
  ([non-functional-requirements.md](../non-functional-requirements.md)).
- **Side-effect posture.** Tools that publish, send, or deliver
  (Micropub create, Webmention send, AP delivery) MUST set
  `readOnlyHint: false` / `destructiveHint` truthfully and SHOULD offer a
  dry-run parameter; the default composition separates read scopes from
  write scopes so an owner can mint a read-only agent token.
- **Prompt-injection surface is documented per tool.** Inbox-reading tools
  (Microsub timeline, webmention listing, LDN/AP inboxes) return
  **attacker-supplied content** to the model. The lib cannot fix that, but
  each contributed tool's description MUST say so, and outward-facing tools
  MUST NOT be silently composable with inbox reads at a wider scope than the
  token grants (the agentic-inbox lesson: human confirmation before send).

## Testing

- Node unit tests for the protocol core: lifecycle/version negotiation,
  batch + notification handling, JSON-RPC error mapping, registry dispatch,
  scope-intersection authz (allowed / insufficient-scope / no-token), and
  annotation passthrough.
- The endpoint packages test their own tool factories in their existing
  workerd projects (e.g. a `tools/call` of the Micropub publish tool against
  Miniflare bindings).

## Open questions

- Which MCP **protocol revision** to pin for v1, and how to handle
  `initialize` version negotiation as revisions advance.
- Whether `tools/list` should be filterable by the caller's scopes (hide
  tools the token can never call) or complete-but-annotated.
- Whether an MCP conformance suite exists worth wiring into
  `conformance/status.json`, or the package enters as `not-applicable`.
