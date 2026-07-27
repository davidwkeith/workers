/**
 * Loads `<domain>.env` and/or `.env` into `process.env` via
 * `@dotenvx/dotenvx` (parsing + `encrypted:`-value decryption).
 * `@dwk/server` is the one place in the repo allowed to read the
 * environment (spec/composition-contract.md); this is a small helper the
 * composition root calls before it does.
 *
 * Precedence, high to low: real `process.env` (already set before this
 * runs) > `<domain>.env` (`<domain>` is the hostname of `DWK_BASE_URL`) >
 * `.env`. Missing files are silently skipped — dotenvx's default
 * (non-strict) behavior already tolerates a missing path without throwing,
 * so no existence check is needed here.
 *
 * @see spec/self-hosting.md §9
 */
import { config as dotenvxConfig } from "@dotenvx/dotenvx";
import { join } from "node:path";

/** Options for {@link loadDwkEnv}. */
export interface LoadDwkEnvOptions {
  /** Directory to look for `.env` / `<domain>.env` in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** The hostname of `baseUrl`, or `undefined` if unset or unparseable. */
function domainFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Load the given paths via dotenvx, throwing on any non-ignored error. */
function load(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const result = dotenvxConfig({
    path: [...paths],
    quiet: true,
    ignore: ["MISSING_ENV_FILE"],
  });
  if (result.error) throw result.error;
}

/**
 * Load `<domain>.env` (derived from `DWK_BASE_URL`'s hostname, if known) and
 * `.env` from `cwd`, in that precedence. Safe to call whether or not either
 * file exists.
 */
export function loadDwkEnv(options: LoadDwkEnvOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const path = (name: string): string => join(cwd, name);

  const domain = domainFromBaseUrl(process.env.DWK_BASE_URL);
  load(domain ? [path(`${domain}.env`), path(".env")] : [path(".env")]);

  // DWK_BASE_URL wasn't known externally — it may have just been set by the
  // .env loaded above. Check again, and layer in a matching <domain>.env
  // that wasn't already part of the first load.
  if (!domain) {
    const discovered = domainFromBaseUrl(process.env.DWK_BASE_URL);
    if (discovered) load([path(`${discovered}.env`)]);
  }
}
