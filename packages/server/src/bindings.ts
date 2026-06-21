/**
 * Declarative assembly of the Node-backed binding shims into an `Env`.
 *
 * `@dwk/server` is the composition root and `./shims` holds the raw
 * Cloudflare-interface emulations; this module is the small glue between them.
 * Given a data directory and the binding *names* a set of mounted packages
 * declare, it instantiates one shim per binding under a deterministic on-disk
 * layout and returns the assembled `Env` the handlers receive:
 *
 * ```
 * <dataDir>/d1/<NAME>.sqlite   one SQLite file per D1 binding
 * <dataDir>/r2/<NAME>/         one directory per R2 bucket (objects + sidecars)
 * <dataDir>/kv/<NAME>.sqlite   one SQLite file per persisted KV namespace
 * ```
 *
 * It is intentionally package-agnostic: it knows binding *kinds*, not which
 * package owns them, so the host stays decoupled from the 20+ endpoint packages
 * (the actual choice of what to mount lives in the deployer's composition root).
 * Secrets are injected the same way Worker secret bindings are — as plain `Env`
 * members. Queue/cron bindings are a lifecycle concern and come from the
 * {@link ./shims/queue.QueueBroker} / {@link ./shims/cron.CronScheduler}
 * directly, not from here.
 *
 * @see spec/self-hosting.md §7.1–§7.3, §9
 */

import { join } from "node:path";
import { createD1Database } from "./shims/d1.js";
import { createR2Bucket } from "./shims/r2.js";
import { createKVNamespace } from "./shims/kv.js";

/** A KV namespace binding that may opt out of on-disk persistence. */
export interface KvBindingSpec {
  /** The `Env` key the namespace is bound to (e.g. `"SESSION_CACHE"`). */
  readonly name: string;
  /**
   * Keep the namespace in memory (a cache that does not survive a restart)
   * instead of persisting it to SQLite. KV is only ever a safe-to-be-stale
   * cache (see the non-functional rules), so either backing is correct.
   */
  readonly memory?: boolean;
}

/** The bindings a set of mounted packages declare, by kind. */
export interface BindingsSpec {
  /** Root directory all stores live under (created on demand by the shims). */
  readonly dataDir: string;
  /** D1 binding names → one SQLite file each under `d1/`. */
  readonly d1?: readonly string[];
  /** R2 bucket binding names → one directory each under `r2/`. */
  readonly r2?: readonly string[];
  /** KV namespace bindings → one SQLite file each under `kv/` (unless `memory`). */
  readonly kv?: readonly (string | KvBindingSpec)[];
  /**
   * Secret bindings (e.g. `TOKEN_SIGNING_KEY`) injected as `Env` members. An
   * `undefined` value is skipped, so the startup `assertBindings` check reports
   * it as a missing required binding rather than masking it with `undefined`.
   */
  readonly secrets?: Readonly<Record<string, string | undefined>>;
}

/** Storage-binding name → file/directory component, so traversal is impossible. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Assemble the shim-backed `Env` for a {@link BindingsSpec}. Each storage
 * binding becomes a shim instance under the documented `dataDir` layout, and
 * secrets are merged in as plain members. Throws if a storage-binding name is
 * unsafe as a path component, or if any two bindings would collide on the same
 * `Env` key.
 */
export function assembleBindings(spec: BindingsSpec): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  for (const name of spec.d1 ?? []) {
    assertStorageName(name, "D1");
    claim(env, name);
    env[name] = createD1Database(join(spec.dataDir, "d1", `${name}.sqlite`));
  }

  for (const name of spec.r2 ?? []) {
    assertStorageName(name, "R2");
    claim(env, name);
    env[name] = createR2Bucket(join(spec.dataDir, "r2", name));
  }

  for (const entry of spec.kv ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    const memory = typeof entry === "string" ? false : entry.memory === true;
    assertStorageName(name, "KV");
    claim(env, name);
    env[name] = createKVNamespace(
      memory ? {} : { location: join(spec.dataDir, "kv", `${name}.sqlite`) },
    );
  }

  for (const [name, value] of Object.entries(spec.secrets ?? {})) {
    if (value === undefined) continue;
    claim(env, name);
    env[name] = value;
  }

  return env;
}

function assertStorageName(name: string, kind: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `invalid ${kind} binding name ${JSON.stringify(name)}: a binding name ` +
        `is used as an on-disk path component and must match ${SAFE_NAME}`,
    );
  }
}

function claim(env: Record<string, unknown>, name: string): void {
  if (Object.prototype.hasOwnProperty.call(env, name)) {
    throw new Error(
      `duplicate binding ${JSON.stringify(name)}: two bindings cannot share ` +
        `the same Env key`,
    );
  }
}
