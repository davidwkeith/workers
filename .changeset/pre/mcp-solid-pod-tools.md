---
"@dwk/solid-pod": minor
---

Add `createSolidPodMcpTools` (#262): a `@dwk/mcp` tool contribution exposing
`solid_pod_read` and `solid_pod_write`. Both dispatch through the same
internal `Request` shape `createSolidPod`'s HTTP door sends to the per-pod
`SolidPodObject` Durable Object, so the pod's existing WAC evaluation is a
second, resource-level gate beneath the MCP scope check — a caller's WebID
(the MCP token's resolved `subject`) still has to be granted access under
the pod's `.acl`s. `solid_pod_write` supports a `dryRun` preview and refuses
outright when the caller has no resolved subject, since the pod's write
path requires proof of an authenticated identity. `forwardedConfig` is now
exported from `handler.ts`, and `resolveConfig`/`ResolvedConfig` from
`index.ts`, so the tool factory can build the same wire format without
duplicating it. `solid_pod_read` rejects a protocol-relative path (a
leading `//`, which `new URL` would otherwise resolve off-origin) and caps
the response body via `@dwk/safe-fetch`'s `readBodyCapped` (2 MB) so a
large pod resource can't be read into unbounded Worker memory through an
LLM-bound tool call.
