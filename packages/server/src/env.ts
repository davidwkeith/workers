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
 * @see spec/self-hosting.md §9.1
 */
import {
  config as dotenvxConfig,
  parse as dotenvxParse,
  type DotenvParseOptions,
} from "@dotenvx/dotenvx";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `parse()`'s `DotenvParseOptions` type doesn't declare `ignore`, but the
 * implementation reads and honors it identically to `config()`'s (typed)
 * `ignore` option — this just closes that gap in the upstream `.d.ts`.
 */
type PeekParseOptions = DotenvParseOptions & {
  readonly ignore?: readonly string[];
};

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

/**
 * `DWK_BASE_URL`, from the real environment if already set, else peeked out
 * of `.env`'s content (without writing anything to `process.env` — that
 * only happens once, in the single ordered `load()` call below, so a
 * `<domain>.env` discovered this way still gets to override `.env`'s
 * overlapping keys). An encrypted `DWK_BASE_URL` can't be peeked this way —
 * `parse()` here is given no private key, so it would otherwise log a
 * `MISSING_PRIVATE_KEY`/`DECRYPTION_FAILED` error even though this is an
 * expected, handled case (the fallback pass in `loadDwkEnv` below covers
 * it once the real decrypting `load()` call has run).
 */
function peekBaseUrl(cwd: string): string | undefined {
  if (process.env.DWK_BASE_URL) return process.env.DWK_BASE_URL;
  try {
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    const options: PeekParseOptions = {
      ignore: ["MISSING_PRIVATE_KEY", "DECRYPTION_FAILED"],
    };
    const parsed = dotenvxParse(raw, options);
    const value = parsed.DWK_BASE_URL;
    // An unresolved encrypted value comes back as the literal ciphertext
    // (dotenvx's "encrypted:" prefix) rather than throwing — reject it
    // explicitly instead of relying on new URL(...) happening to fail on it.
    if (typeof value !== "string" || value.startsWith("encrypted:")) {
      return undefined;
    }
    return value;
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
    noNative: true,
    noArmor: true,
    no1Password: true,
    noBitwarden: true,
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

  const domain = domainFromBaseUrl(peekBaseUrl(cwd));
  load(domain ? [path(`${domain}.env`), path(".env")] : [path(".env")]);

  // If DWK_BASE_URL couldn't be peeked above (e.g. it's itself an encrypted
  // value in .env), the load above only covered .env. Now that .env has
  // been decrypted for real, check again and load a matching <domain>.env
  // as an additional layer — it can't override keys .env already set
  // (dotenvx never overwrites an already-set process.env value), but
  // loading it at all is strictly better than never loading it.
  if (!domain) {
    const discovered = domainFromBaseUrl(process.env.DWK_BASE_URL);
    if (discovered) load([path(`${discovered}.env`)]);
  }
}
