/**
 * A `module.register` ESM loader hook that redirects the bare `cloudflare:workers`
 * specifier to the Node shim ({@link ./cloudflare-workers}).
 *
 * Node's `imports` field can't be used here — it only remaps `#`-prefixed
 * specifiers — and editing the packages' source imports is off the table (they
 * must run unchanged from published dist). A resolve hook is the seam: the
 * consuming host (e.g. `@dwk/server`'s `bin`) calls
 * {@link registerCloudflareWorkers} before importing any package that extends
 * `DurableObject`. Tests use a Vitest `resolve.alias` instead, so this hook is
 * not on the test path; a bundling host may use a build-time alias to
 * `@dwk/cf-shims/cloudflare-workers` instead.
 *
 * @see spec/self-hosting.md §7.4 (decision 1)
 */

import { register } from "node:module";

/** The specifier the packages import `{ DurableObject }` from. */
const CLOUDFLARE_WORKERS = "cloudflare:workers";

interface ResolveContext {
  readonly conditions: readonly string[];
  readonly parentURL?: string;
}
interface ResolveResult {
  readonly url: string;
  readonly shortCircuit?: boolean;
  readonly format?: string | null;
}
type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<ResolveResult>;

/** The resolve hook: map `cloudflare:workers` → the shim, else defer. */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  if (specifier === CLOUDFLARE_WORKERS) {
    return {
      url: new URL("./cloudflare-workers.js", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

/**
 * Register the loader hook in the current process. Call once at startup, before
 * importing any package that does `import { DurableObject } from
 * "cloudflare:workers"`.
 */
export function registerCloudflareWorkers(): void {
  try {
    register("./cloudflare-workers-loader.js", import.meta.url);
  } catch {
    // Best-effort. Environments that resolve `cloudflare:workers` another way —
    // the esbuild bundle's build-time alias, or a test-runner alias — do not
    // need the hook, and failing to register one there is benign. A genuine
    // misconfiguration still surfaces as a clear missing-module error when a
    // Durable-Object package is first imported.
  }
}
