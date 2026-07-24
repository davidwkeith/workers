/**
 * Declarative assembly of centralized-store shims into an `Env` — the
 * `central` storage mode's counterpart to {@link assembleBindings}.
 *
 * Mirrors `bindings.ts` exactly in shape (binding *kind* → shim instance,
 * package-agnostic, secrets merged in as plain members) but composes
 * `@dwk/deno-host`'s centralized-store shims instead of `@dwk/cf-shims`'
 * local ones, per the binding-by-binding mapping in
 * [spec/scale-out.md §5](../../../spec/scale-out.md#5-binding-by-binding-mapping):
 *
 * - **D1** → `@dwk/deno-host`'s `createD1Database` over an injected
 *   `LibsqlClientLike`, one per binding — the composing deployer decides
 *   whether several bindings share one physical libSQL database or each gets
 *   its own (host-contract §3.5's read-your-writes holds either way, since
 *   every query lands at whichever primary the injected client is bound to).
 * - **R2** → `@dwk/deno-host`'s `createS3Bucket` over an injected, already-
 *   signing `S3ClientLike` (e.g. `aws4fetch`'s `AwsClient#fetch`).
 * - **KV** → always **per-replica in-memory** (`@dwk/cf-shims`' memory
 *   backing) — KV is only ever a safe-to-be-stale cache (see the
 *   non-functional rules), so centralizing it would trade correctness for
 *   nothing; a replica-local cache is both conforming and faster.
 *
 * Neither shim is constructed from raw connection credentials here — like
 * every `@dwk/deno-host` seam, the composing deployer injects an
 * already-connected client (a real `@libsql/client` instance, an `aws4fetch`
 * signer), and this module only wires it into the `Env` shape the handlers
 * expect. `@dwk/server` itself never constructs a network connection.
 *
 * @see spec/scale-out.md §5, §9 (issue #431)
 */

import { createD1Database, createS3Bucket } from "@dwk/deno-host";
import type { LibsqlClientLike, S3ClientLike } from "@dwk/deno-host";
import { createKVNamespace } from "@dwk/cf-shims";

/** One R2 bucket binding: an already-signing client plus its bucket endpoint. */
export interface CentralR2BindingSpec {
  /** Already-authenticated/signed fetch for the target S3-compatible provider. */
  readonly client: S3ClientLike;
  /** Path-style base URL up to and including the bucket (no trailing slash). */
  readonly endpoint: string;
}

/** The bindings a set of mounted packages declare, by kind, for `central` mode. */
export interface CentralBindingsSpec {
  /** D1 binding names → an injected libSQL client each. */
  readonly d1?: Readonly<Record<string, LibsqlClientLike>>;
  /** R2 bucket binding names → an injected S3-compatible client + endpoint each. */
  readonly r2?: Readonly<Record<string, CentralR2BindingSpec>>;
  /** KV namespace binding names — always per-replica in-memory in central mode. */
  readonly kv?: readonly string[];
  /**
   * Secret bindings (e.g. `TOKEN_SIGNING_KEY`) injected as `Env` members. An
   * `undefined` value is skipped, so the startup `assertBindings` check reports
   * it as a missing required binding rather than masking it with `undefined`.
   */
  readonly secrets?: Readonly<Record<string, string | undefined>>;
}

/**
 * Assemble the centralized-store `Env` for a {@link CentralBindingsSpec}.
 * Throws if two bindings would collide on the same `Env` key — the same
 * invariant {@link assembleBindings} enforces for local mode.
 */
export function assembleCentralBindings(
  spec: CentralBindingsSpec,
): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  for (const [name, client] of Object.entries(spec.d1 ?? {})) {
    claim(env, name);
    env[name] = createD1Database(client);
  }

  for (const [name, binding] of Object.entries(spec.r2 ?? {})) {
    claim(env, name);
    env[name] = createS3Bucket(binding);
  }

  for (const name of spec.kv ?? []) {
    claim(env, name);
    env[name] = createKVNamespace({});
  }

  for (const [name, value] of Object.entries(spec.secrets ?? {})) {
    if (value === undefined) continue;
    claim(env, name);
    env[name] = value;
  }

  return env;
}

function claim(env: Record<string, unknown>, name: string): void {
  if (Object.prototype.hasOwnProperty.call(env, name)) {
    throw new Error(
      `duplicate binding ${JSON.stringify(name)}: two bindings cannot share ` +
        `the same Env key`,
    );
  }
}
