/**
 * The Node stand-in for the `cloudflare:workers` runtime module.
 *
 * The endpoint packages' only runtime import from `cloudflare:workers` is
 * `{ DurableObject }` (in `@dwk/solid-pod`, `@dwk/webauthn`, and
 * `@dwk/activitypub` — 3 files). Under Node the bare specifier is redirected
 * here, so those packages run unchanged from their published dist:
 *
 * - in production, via a `module.register` loader hook (see
 *   {@link ./cloudflare-workers-loader}), installed by the host `bin`;
 * - in tests, via a Vitest `resolve.alias` (see `vitest.config.ts`).
 *
 * @see spec/self-hosting.md §7.4
 */

export { DurableObject } from "./durable-object.js";
