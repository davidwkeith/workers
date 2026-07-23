/**
 * Install a Node `HTMLRewriter` global.
 *
 * Some packages scan HTML with the Workers runtime's streaming `HTMLRewriter` —
 * a workerd built-in Node lacks — rather than bundling a parser:
 * `@dwk/webmention` link verification and `@dwk/microsub` HTML feed / `h-feed`
 * discovery both depend on it. To run those packages unchanged, the host
 * installs a WASM-backed, workerd-compatible implementation onto `globalThis`
 * when none exists. The self-contained `base64` build is used so the WASM is
 * inlined (nothing is fetched at runtime — important for an offline / locked-down
 * self-host). Idempotent, and a no-op where a native `HTMLRewriter` already
 * exists (e.g. on workerd, or if the deployer installed their own).
 *
 * @see spec/self-hosting.md §7.5
 */

import { HTMLRewriter } from "@worker-tools/html-rewriter/base64";

/** Install the WASM `HTMLRewriter` as a global if one is not already present. */
export function installHTMLRewriter(): void {
  const g = globalThis as { HTMLRewriter?: unknown };
  g.HTMLRewriter ??= HTMLRewriter;
}
