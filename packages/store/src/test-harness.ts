/**
 * Test-only Worker entrypoint: a SQLite-backed Durable Object whose `state` and
 * `env` the tests drive directly via `runInDurableObject`. Excluded from the
 * published build. Not part of the package's public surface.
 */

import { DurableObject } from "cloudflare:workers";

import type { StoreEnv } from "./index";

/** Bindings wired up by the vitest pool (`vitest.config.ts`). */
export interface HarnessEnv extends StoreEnv {
  readonly POD_DO: DurableObjectNamespace<StoreTestObject>;
  readonly GC_DB: D1Database;
}

/** Minimal SQLite-backed DO; `createStore` runs against its `ctx` in tests. */
export class StoreTestObject extends DurableObject<HarnessEnv> {
  /** Public accessor so `runInDurableObject` callbacks can reach the bindings. */
  get bindings(): HarnessEnv {
    return this.env;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
} satisfies ExportedHandler<HarnessEnv>;
