/**
 * Release gate (issue #12).
 *
 * Conformance is a release gate, not a nice-to-have: a package MUST NOT be
 * published at a stable (>=1.0.0) version until it passes the conformance
 * suite(s) relevant to its standard and its integration lifecycle tests are
 * green. See spec/conformance-and-testing.md and conformance/README.md.
 *
 * This guard reads every workspace package's declared version and cross-checks
 * it against conformance/status.json. Any package whose version is stable
 * (major >= 1, no prerelease tag) while any of its conformance suites or its
 * integration lifecycle status is not "passing" is a violation, and the gate
 * exits non-zero so `pnpm release` (and CI) refuses to proceed.
 *
 * Pure-data and importable: `evaluateReleaseGate` is unit-tested by
 * scripts/release-gate.test.mjs without spawning the CLI.
 *
 * Usage:
 *   node scripts/release-gate.mjs            # enforce; exit 1 on violation
 *   node scripts/release-gate.mjs --report   # print the status table only
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdout } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse a semver-ish version string. Returns null if it cannot be parsed.
 * @param {string} version
 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    String(version),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * A version counts as "stable" (subject to the gate) when its major is >= 1 and
 * it carries no prerelease tag. 0.x and `-rc` style versions are exempt.
 * @param {string} version
 */
export function isStable(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.major >= 1 && parsed.prerelease === null;
}

/**
 * Read every workspace package's name + version from packages/*\/package.json.
 * @param {string} [root]
 * @returns {{ name: string, version: string, dir: string }[]}
 */
export function loadPackages(root = ROOT) {
  const packagesDir = join(root, "packages");
  const out = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    let raw;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      // No package.json at all in this directory — not a package, skip.
      continue;
    }
    // A package.json that *exists* but fails to parse (or isn't the object
    // shape npm requires) is a real repo defect, not an absent package: the
    // gate cannot verify that package's stability/conformance at all, so
    // silently skipping it would let a broken manifest dodge the release
    // gate entirely. Fail loudly instead.
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `release-gate: ${manifestPath} is not valid JSON: ${err.message}`,
        { cause: err },
      );
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`release-gate: ${manifestPath} is not a JSON object`);
    }
    if (manifest.private) continue;
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    ) {
      throw new Error(
        `release-gate: ${manifestPath} is missing a string \`name\`/\`version\` (required for every non-private package)`,
      );
    }
    out.push({
      name: manifest.name,
      version: manifest.version,
      dir: entry.name,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read conformance/status.json.
 * @param {string} [root]
 */
export function loadStatus(root = ROOT) {
  return JSON.parse(
    readFileSync(join(root, "conformance", "status.json"), "utf8"),
  );
}

/**
 * Evaluate the gate against a set of packages and the conformance status doc.
 * Returns a list of human-readable violation strings (empty == gate passes).
 *
 * @param {{ packages: { name: string, version: string }[], status: any }} input
 * @returns {string[]}
 */
export function evaluateReleaseGate({ packages, status }) {
  const violations = [];
  for (const pkg of packages) {
    if (!isStable(pkg.version)) continue;

    const entry = status.packages?.[pkg.name];
    if (!entry) {
      violations.push(
        `${pkg.name}@${pkg.version} is stable but has no conformance/status.json entry.`,
      );
      continue;
    }

    // For stable packages, ensure there's at least one suite entry (passing or
    // not-applicable) when integration is not-applicable. An empty suites object
    // with not-applicable integration passes vacuously, allowing a stable release
    // with zero conformance evidence.
    const hasSuite = Object.keys(entry.suites ?? {}).length > 0;
    const integration = entry.integration?.status;
    if (!hasSuite && integration === "not-applicable") {
      violations.push(
        `${pkg.name}@${pkg.version}: stable package with no conformance suites and integration "not-applicable" — mark at least one suite as "not-applicable" to gate the release.`,
      );
    }

    for (const [suite, result] of Object.entries(entry.suites ?? {})) {
      const status = result?.status;
      if (status !== "passing" && status !== "not-applicable") {
        violations.push(
          `${pkg.name}@${pkg.version}: conformance suite "${suite}" is "${status}" (must be "passing").`,
        );
      }
      // Per-target results (e.g. the self-hosted Node host) gate too.
      for (const [target, tResult] of Object.entries(result?.targets ?? {})) {
        const tStatus = tResult?.status;
        if (tStatus !== "passing" && tStatus !== "not-applicable") {
          violations.push(
            `${pkg.name}@${pkg.version}: conformance suite "${suite}" on target "${target}" is "${tStatus}" (must be "passing").`,
          );
        }
      }
    }

    if (integration !== "passing" && integration !== "not-applicable") {
      violations.push(
        `${pkg.name}@${pkg.version}: integration lifecycle tests are "${integration}" (must be "passing").`,
      );
    }
    for (const [target, tResult] of Object.entries(
      entry.integration?.targets ?? {},
    )) {
      const tStatus = tResult?.status;
      if (tStatus !== "passing" && tStatus !== "not-applicable") {
        violations.push(
          `${pkg.name}@${pkg.version}: integration lifecycle tests on target "${target}" are "${tStatus}" (must be "passing").`,
        );
      }
    }
  }
  return violations;
}

/**
 * Render a status table for every package (used by --report and on failure).
 * @param {{ packages: { name: string, version: string }[], status: any }} input
 */
export function renderReport({ packages, status }) {
  const lines = [];
  for (const pkg of packages) {
    const entry = status.packages?.[pkg.name];
    const gated = isStable(pkg.version) ? "GATED" : "exempt";
    const suites = entry
      ? Object.entries(entry.suites ?? {})
          .map(([name, r]) => `${name}=${r?.status ?? "unknown"}`)
          .join(", ") || "—"
      : "(no entry)";
    const integration = entry?.integration?.status ?? "(none)";
    const targets = entry?.integration?.targets ?? {};
    const targetsSummary = Object.entries(targets)
      .map(([target, r]) => ` ${target}:${r?.status ?? "unknown"}`)
      .join("");
    lines.push(
      `  ${pkg.name}@${pkg.version} [${gated}]  suites: ${suites}  integration: ${integration}${targetsSummary}`,
    );
  }
  return lines.join("\n");
}

function main() {
  const reportOnly = argv.includes("--report");
  const packages = loadPackages();
  const status = loadStatus();

  stdout.write("Release gate — conformance & integration status:\n");
  stdout.write(renderReport({ packages, status }) + "\n\n");

  if (reportOnly) {
    exit(0);
  }

  const violations = evaluateReleaseGate({ packages, status });
  if (violations.length > 0) {
    stdout.write("Release gate FAILED. Stable releases are blocked:\n");
    for (const v of violations) stdout.write(`  ✗ ${v}\n`);
    stdout.write(
      '\nUpdate conformance/status.json to "passing" only once the relevant\n' +
        "conformance suite(s) and integration lifecycle tests are green.\n",
    );
    exit(1);
  }

  stdout.write(
    "Release gate passed: no stable package violates conformance.\n",
  );
  exit(0);
}

// Run only when invoked directly, not when imported by the test.
if (fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
