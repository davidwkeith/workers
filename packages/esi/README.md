# @dwk/esi

Streaming Edge Side Includes (ESI) processor for a composed Worker's outgoing
`Response`, so a mostly-static, edge-cacheable shell can splice in live
fragments at request time.

Supports a pragmatic v1 subset of three tags:

- `<esi:include src="…" alt="…"? onerror="continue"?/>` — fetch `src`
  (through `@dwk/safe-fetch`) and splice the fragment body in place.
- `<esi:comment text="…"/>` — no-op, removed from output.
- `<esi:remove>…</esi:remove>` — the block and its contents are stripped
  from output entirely.

See
[`docs/superpowers/specs/2026-07-13-esi-design.md`](../../docs/superpowers/specs/2026-07-13-esi-design.md)
for the full design rationale.

## Usage

```ts
import { processEsi } from "@dwk/esi";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const shell = await buildShellResponse(request, env);
    return processEsi(shell, { baseUrl: request.url });
  },
};
```
