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
import {
  config as dotenvxConfig,
  parse as dotenvxParse,
} from "@dotenvx/dotenvx";
import { readFileSync } from "node:fs";
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

/**
 * `DWK_BASE_URL`, from the real environment if already set, else peeked out
 * of `.env`'s content (without writing anything to `process.env` — that
 * only happens once, in the single ordered `load()` call below, so a
 * `<domain>.env` discovered this way still gets to override `.env`'s
 * overlapping keys). A `.env` whose `DWK_BASE_URL` is itself an encrypted
 * value can't be peeked this way (no private key is applied here); such a
 * setup falls back to loading `.env` alone, same as if no domain were known.
 */
function peekBaseUrl(cwd: string): string | undefined {
  if (process.env.DWK_BASE_URL) return process.env.DWK_BASE_URL;
  try {
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    const parsed = dotenvxParse(raw);
    return typeof parsed.DWK_BASE_URL === "string"
      ? parsed.DWK_BASE_URL
      : undefined;
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
  const beforeEnv = { ...process.env };
  load(domain ? [path(`${domain}.env`), path(".env")] : [path(".env")]);

  // Verify no encrypted values were left unresolved (missing or invalid private keys).
  const unresolved: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      value.startsWith("encrypted:") &&
      beforeEnv[key] !== value
    ) {
      unresolved.push(key);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `[DECRYPTION_FAILED] could not decrypt ${unresolved.join(", ")} (missing or invalid private key)`,
    );
  }
}
