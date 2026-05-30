# Composition contract (cross-cutting)

These rules are what make the packages *usable* rather than merely present.
Every endpoint package MUST follow them; library packages MUST follow the ones
that apply (config, no-global-env, distribution).

## Handler shape

Each endpoint package MUST export a factory that returns a `fetch`-compatible
handler:

```ts
createX(config: XConfig): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
```

The handler MUST be mountable under a path prefix, so a consumer can route
several packages inside one Worker (see the example in the
[root README](../README.md#composition-model)).

## Bindings contract

- Each package MUST declare the Cloudflare bindings it requires as a TypeScript
  `Env` interface fragment (R2 bucket, D1 database, DO namespace, KV, secrets).
- The composed `Env` is the **union** of every mounted package's fragment;
  consumers satisfy it in `wrangler.toml`.
- A package MUST **fail loudly at startup** if a required binding is missing —
  no silent degradation.

## Config object

- Packages MUST NOT read from the global environment directly. All config
  — base URL / domain, issuer, allowed origins, storage namespace, size
  thresholds — is passed into the factory.
- This allows the same package to be instantiated multiple times and tested in
  isolation.

## Confinement of Cloudflare specifics

- Cloudflare-specific concerns are confined to `@dwk/store` and the endpoint
  packages.
- `@dwk/wac`, `@dwk/rdf`, and `@dwk/dpop` MUST take their inputs as plain data,
  so they unit-test without a Workers runtime.

## Distribution shape

- **ESM-only**, tree-shakeable, and fully typed (ship `.d.ts`).
- Dependencies MUST be minimized and pinned.

See [non-functional-requirements.md](non-functional-requirements.md) for the
release/semver and runtime-budget rules that complement these.
