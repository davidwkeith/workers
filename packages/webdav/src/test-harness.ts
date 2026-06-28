/**
 * Test-only Worker entrypoint: a SQLite-backed Durable Object whose `ctx`/`env`
 * the tests drive via `runInDurableObject`, so the lock + credential stores and
 * the verb router exercise **real** DO SQLite (spec §2: this state lives in the
 * DO, never KV). Excluded from the published build; not part of the public
 * surface.
 */

import { DurableObject } from "cloudflare:workers";

/** Minimal SQLite-backed DO; the stores run against its `ctx.storage.sql`. */
export class WebdavTestObject extends DurableObject {
  /** Public accessor so `runInDurableObject` callbacks reach the SQL store. */
  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
} satisfies ExportedHandler;
