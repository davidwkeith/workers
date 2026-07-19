# `@dwk/mcp`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Used by** | tool contributions from the endpoint packages (`@dwk/micropub`, `@dwk/microsub`, `@dwk/webmention`, `@dwk/solid-pod`, `@dwk/activitypub`) |
| **Standard** | [Model Context Protocol](https://modelcontextprotocol.io/specification) (JSON-RPC 2.0 over Streamable HTTP) |
| **Status** | **v1 and v2 tool contributions implemented.** The protocol core (`createMcp`, JSON-RPC 2.0 + Streamable HTTP lifecycle, tool registry with scope-intersection authz), the auth bridge (`createDpopBearerAuthenticator`: bearer + DPoP-bound token validation via `@dwk/dpop`, RFC 9728 protected-resource-metadata challenge on `401`), the v1 tool contributions (`@dwk/micropub`'s `createMicropubMcpTools`, `@dwk/microsub`'s `createMicrosubMcpTools`, `@dwk/webmention`'s `createWebmentionMcpTools`), and the v2 tool contributions (`@dwk/solid-pod`'s `createSolidPodMcpTools` → `solid_pod_read`/`solid_pod_write`; `@dwk/activitypub`'s `createActivitypubMcpTools` → `activitypub_list_inbox`) are implemented and tested. Tracked in [#240](https://github.com/davidwkeith/workers/issues/240) / [#262](https://github.com/davidwkeith/workers/issues/262) |

> The load-bearing decisions below (tools-only subset, auth bridge shape,
> side-effect posture) were sketched here before implementation, per
> [#240](https://github.com/davidwkeith/workers/issues/240).

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
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), a
  required scope string, and a handler closure over the package's existing
  machinery.
- **v1 tool contributions — implemented.** `@dwk/micropub`'s
  `createMicropubMcpTools` adds `micropub_publish` (side-effecting,
  `readOnlyHint: false`, supports a `dryRun` preview), closing over the same
  `publishPost` path the HTTP `create` action uses so both share identical
  slug-generation and collision-retry behavior. `@dwk/microsub`'s
  `createMicrosubMcpTools` adds the read-only `microsub_list_channels` and
  `microsub_get_timeline`. `@dwk/webmention`'s `createWebmentionMcpTools` adds
  the read-only `webmention_list_received`. Each factory takes the package's
  existing store (or resolved config) directly — no HTTP `Request`/`Response`
  in the tool path — so the composing Worker builds the tool list per-request
  from the already-bound `env`, then passes it into `createMcp`.
- **v2 tool contributions — implemented.** `@dwk/solid-pod`'s
  `createSolidPodMcpTools` adds `solid_pod_read` (read-only) and
  `solid_pod_write` (side-effecting, supports a `dryRun` preview). Unlike the
  v1 packages, the pod has no plain-data store reachable from the Worker: its
  authority is the per-pod `SolidPodObject` Durable Object, so both tools
  dispatch through the same internal `Request` shape `createSolidPod`'s HTTP
  door sends (config + `x-solid-webid` from the MCP token's resolved
  `subject`), which means the DO's existing WAC evaluation is a **second,
  resource-level gate** beneath the MCP scope check, exactly as the design
  called for — a caller with the `write` scope but no WAC `Write` grant on a
  given resource still gets refused. Because the pod's write path also
  requires a DPoP proof `jti` to be present (`allowAnonymousWrites` is the
  only documented exception), `solid_pod_write` synthesizes a one-time `jti`
  per call rather than forwarding a real Solid-OIDC proof — the caller
  already went through `@dwk/mcp`'s own DPoP replay protection to reach this
  tool at all — and refuses outright when the auth context has no resolved
  `subject`, so an anonymous MCP caller can never ride that synthesis into a
  write `allowAnonymousWrites` would otherwise have blocked. `@dwk/activitypub`'s
  `createActivitypubMcpTools` adds the read-only `activitypub_list_inbox`,
  reading the per-actor `ActivityPubObject` Durable Object's `inbox` table
  through a new internal-only `__inbox` route (parallel to the existing
  `__stats`/`__resolve`/`__deliver` routes) — the public `/inbox` route stays
  write-only to peers per ActivityPub §7.1, so this is a genuinely new,
  owner-only read surface, not a reuse of an existing HTTP GET.
- **v3 tool contributions — implemented (fediverse interop phase 3, #279).**
  `@dwk/activitypub`'s tool set grows `activitypub_publish` (write-scoped —
  a deliberately distinct scope from the read tools, so a read-scoped agent
  can never post as the owner) taking the canonical `PostInput` shape and
  routing through the same internal publish path as `POST <actor>/publish`,
  with handle-shaped community audiences (`!birding@lemmy.ml`) resolved via
  the SSRF-guarded `@dwk/webfinger` lookup; and the read-only
  `activitypub_resolve`, dereferencing a handle to its actor IRI + AS2 type
  (`Person`/`Group`) + profile basics — remote-controlled data an agent MUST
  treat as untrusted (see spec/fediverse-interop.md, Capability 3).
- **Auth bridge — implemented.** MCP authorization is OAuth 2.1-shaped, so
  this reuses what the repo owns rather than inventing anything:
  `createDpopBearerAuthenticator` (`src/auth.ts`) builds the `authenticate`
  hook `createMcp` accepts, verifying bearer + **DPoP-bound** access tokens
  via [`@dwk/dpop`](dpop.md)'s `verifyDpopProof`. It never validates a token
  itself — the composing package supplies a `TokenIntrospector` closure (e.g.
  `@dwk/indieauth`'s `verifyAccessToken`, or a remote RFC 7662 call built on
  [`@dwk/oauth`](oauth.md)) that resolves a token to its active-state, scope,
  subject, and `cnf.jkt` binding. `401` responses advertise the
  protected-resource metadata (RFC 9728-style) via a `WWW-Authenticate: Bearer
  resource_metadata="…"` challenge (`McpHandlerConfig.protectedResourceMetadataUrl`)
  so MCP clients can discover the authorization server; `buildProtectedResourceMetadata`
  (`src/metadata.ts`) builds the plain-data document. The metadata document
  itself lives at the RFC 9728 well-known URI derived from the resource
  identifier (e.g. `/.well-known/oauth-protected-resource/mcp`), **outside
  the handler's mount** — like `@dwk/oauth`'s RFC 8414 document it is static,
  config-derived JSON, so Anglesite (or the composing Worker's root router)
  serves it. Every `tools/call` is checked against the token's granted scopes
  ∩ the tool's required scope — **per-tool least privilege, not a
  perimeter**. DPoP `jti` replay tracking is delegated to a
  strongly-consistent `DpopReplayStore` supplied by the composing package (DO
  SQLite / D1, as the existing endpoint packages already do for their
  DPoP-protected routes — see `@dwk/micropub`'s `replay.ts`) — never KV, and
  never a per-isolate in-memory cache, which provides no replay protection
  across Worker isolates. **Remaining:** the endpoint packages still need to
  wire a concrete `TokenIntrospector` (over `@dwk/indieauth`) and a concrete
  `DpopReplayStore` into a deployed composition — this package only ships the
  bridge's plain-data core.

## Design constraints

- **Plain-data core.** The JSON-RPC layer, lifecycle state machine, and
  registry dispatch take parsed messages in and return plain objects; they
  MUST unit-test under Node without a Workers runtime. Only the thin
  `createMcp` HTTP shell touches `Request`/`Response`.
- **Stateless by default.** Streamable HTTP sessions (`Mcp-Session-Id`) and
  SSE resumability are **not** offered in v1; each POST is independent, which
  suits the stateless-front-door architecture. Per the Streamable HTTP
  transport rules, a `GET` of the endpoint (which would open a
  server-initiated SSE stream) is answered with `405 Method Not Allowed`, as
  is `DELETE` (session termination) — there are no sessions to terminate. If
  session state is ever
  added, it lives in a strongly-consistent store — **never KV**
  ([non-functional-requirements.md](../non-functional-requirements.md)).
- **Side-effect posture.** Tools that publish, send, or deliver
  (Micropub create, Webmention send, AP delivery) MUST set their annotations
  (`readOnlyHint: false`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) truthfully and SHOULD offer a
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

Resolved: no external MCP conformance suite exists to wire into
`conformance/status.json` (unlike micropub.rocks/webmention.rocks/the Solid
conformance harness) — this is a protocol-core lib whose bar is its own
unit/integration tests, the same as every other cross-standard lib in this
repo (`@dwk/dpop`, `@dwk/oauth`, `@dwk/rdf`, …). Recorded as
`integration: "not-applicable"`.
