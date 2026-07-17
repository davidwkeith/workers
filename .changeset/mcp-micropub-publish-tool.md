---
"@dwk/micropub": minor
---

Add `createMicropubMcpTools` (#240): a `@dwk/mcp` tool contribution exposing
`micropub_publish` — publish a new mf2 post (`h-entry`, `h-event`, or any
other type) through the same `publishPost` path (now exported from
`handler.ts`) the HTTP `create` action uses, so both share identical
slug-generation, collision-retry, and persistence behavior. The tool is
side-effecting (`readOnlyHint: false`) and supports a `dryRun` argument that
previews the URL a publish would allocate without persisting anything.
Defaults to requiring the `create` scope, matching the HTTP endpoint.
