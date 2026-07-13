/**
 * `@dwk/esi` — streaming Edge Side Includes (ESI) processor.
 *
 * A pure, runtime-agnostic library: no Cloudflare bindings, no Workers
 * runtime dependency, unit-tests entirely under Node. A composed Worker
 * calls {@link processEsi} on its own outgoing `Response` to resolve
 * `<esi:include>`/`<esi:comment>`/`<esi:remove>` markup, splicing in
 * fragments fetched concurrently through `@dwk/safe-fetch`.
 *
 * @see docs/superpowers/specs/2026-07-13-esi-design.md
 * @packageDocumentation
 */

export { processEsi, type EsiOptions } from "./esi.js";
export {
  createEsiTransformStream,
  type EsiTransformOptions,
} from "./transform.js";
export { resolveFragment, type FragmentFetchOptions } from "./fragment.js";
export { EsiTokenizer, type EsiToken } from "./tokenize.js";
