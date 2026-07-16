/**
 * Catalog gate (issue #255).
 *
 * catalog.json at the repo root is the machine-readable manifest of every
 * mountable worker this monorepo ships — consumed by composing apps
 * (Anglesite's Workers tab and wrangler-config generation, see
 * Anglesite/Anglesite-app#708) over the same raw-file channel as
 * conformance/status.json. Its shape is documented in spec/catalog.md and
 * mirrored by catalog.schema.json.
 *
 * This guard structurally validates catalog.json and cross-checks it against
 * the workspace: every publishable package must either have a worker entry or
 * be listed under `libraries` with a reason, so a new endpoint package cannot
 * ship without a catalog decision. Exits non-zero on any violation.
 *
 * Pure-data and importable: `evaluateCatalog` is unit-tested by
 * scripts/catalog-gate.test.mjs without spawning the CLI.
 *
 * Usage:
 *   node scripts/catalog-gate.mjs   # enforce; exit 1 on violation
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdout } from "node:process";
import { loadPackages } from "./release-gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Valid activation kinds for a worker entry's `binding.kind`. */
const BINDING_KINDS = new Set(["componentTied", "settingsActivated"]);

/** Valid `type` values for a worker entry's `resources` items. */
const RESOURCE_TYPES = new Set([
  "d1",
  "kv",
  "r2",
  "durable-object",
  "queue",
  "secret",
]);

/** Stable-id shape: lowercase kebab slugs, so app-persisted ids stay sane. */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Read catalog.json from the repo root.
 * @param {string} [root]
 */
export function loadCatalog(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structurally validate one worker entry, appending to `violations`.
 * @param {any} entry
 * @param {string} label
 * @param {string[]} violations
 */
function checkEntry(entry, label, violations) {
  for (const field of ["displayName", "description", "group"]) {
    if (!isNonEmptyString(entry[field])) {
      violations.push(`${label}: "${field}" must be a non-empty string.`);
    }
  }

  const binding = entry.binding;
  const kind = binding?.kind;
  if (!BINDING_KINDS.has(kind)) {
    violations.push(
      `${label}: binding.kind must be "componentTied" or "settingsActivated" (got ${JSON.stringify(kind)}).`,
    );
  } else if (kind === "componentTied") {
    const ids = binding.componentIDs;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every(isNonEmptyString)
    ) {
      violations.push(
        `${label}: componentTied requires a non-empty componentIDs array of strings.`,
      );
    }
  } else if (binding.componentIDs !== undefined) {
    violations.push(
      `${label}: settingsActivated entries must not carry componentIDs.`,
    );
  }

  const resources = entry.resources;
  if (!Array.isArray(resources)) {
    violations.push(`${label}: "resources" must be an array (may be empty).`);
    return;
  }
  const seenBindings = new Set();
  for (const resource of resources) {
    const type = resource?.type;
    if (!RESOURCE_TYPES.has(type)) {
      violations.push(
        `${label}: unknown resource type ${JSON.stringify(type)}.`,
      );
      continue;
    }
    if (!isNonEmptyString(resource.binding)) {
      violations.push(
        `${label}: every resource needs a non-empty "binding" name.`,
      );
      continue;
    }
    if (seenBindings.has(resource.binding)) {
      violations.push(
        `${label}: duplicate resource binding "${resource.binding}".`,
      );
    }
    seenBindings.add(resource.binding);
    if (type === "durable-object" && !isNonEmptyString(resource.className)) {
      violations.push(
        `${label}: durable-object resource "${resource.binding}" needs a className.`,
      );
    }
  }
}

/**
 * Validate a catalog document against the workspace's publishable packages.
 * Returns a list of human-readable violation strings (empty == gate passes).
 *
 * @param {{ catalog: any, packages: { name: string }[] }} input
 * @returns {string[]}
 */
export function evaluateCatalog({ catalog, packages }) {
  const violations = [];

  const workers = catalog?.workers;
  if (!Array.isArray(workers)) {
    violations.push('catalog.json: "workers" must be an array.');
    return violations;
  }
  let libraries = {};
  if (catalog.libraries !== undefined) {
    if (
      typeof catalog.libraries === "object" &&
      catalog.libraries !== null &&
      !Array.isArray(catalog.libraries)
    ) {
      libraries = catalog.libraries;
    } else {
      violations.push(
        'catalog.json: "libraries" must be an object mapping package name to reason.',
      );
    }
  }

  const workspaceNames = new Set(packages.map((p) => p.name));
  const ids = new Set();
  const entryPackages = new Set();

  for (const entry of workers) {
    const label = `worker ${JSON.stringify(entry?.id ?? "(missing id)")}`;

    if (!isNonEmptyString(entry?.id) || !ID_PATTERN.test(entry.id)) {
      violations.push(
        `${label}: "id" must be a lowercase kebab-case slug (got ${JSON.stringify(entry?.id)}).`,
      );
    } else if (ids.has(entry.id)) {
      violations.push(`duplicate worker id "${entry.id}".`);
    } else {
      ids.add(entry.id);
    }

    if (!isNonEmptyString(entry?.package)) {
      violations.push(`${label}: "package" must be a non-empty string.`);
    } else {
      if (!workspaceNames.has(entry.package)) {
        violations.push(
          `${label}: package "${entry.package}" is not a publishable workspace package.`,
        );
      }
      entryPackages.add(entry.package);
    }

    checkEntry(entry, label, violations);
  }

  // Second pass: `requires` can reference ids declared later in the file.
  for (const entry of workers) {
    if (entry?.requires === undefined) continue;
    const label = `worker ${JSON.stringify(entry.id)}`;
    for (const required of entry.requires) {
      if (required === entry.id) {
        violations.push(`${label}: must not require itself.`);
      } else if (!ids.has(required)) {
        violations.push(`${label}: requires unknown worker id "${required}".`);
      }
    }
  }

  for (const [name, reason] of Object.entries(libraries)) {
    if (!workspaceNames.has(name)) {
      violations.push(
        `libraries: "${name}" is not a publishable workspace package.`,
      );
    }
    if (entryPackages.has(name)) {
      violations.push(
        `"${name}" is listed both as a worker entry and under libraries.`,
      );
    }
    if (!isNonEmptyString(reason)) {
      violations.push(`libraries: "${name}" needs a non-empty reason string.`);
    }
  }

  for (const name of workspaceNames) {
    if (!entryPackages.has(name) && !(name in libraries)) {
      violations.push(
        `${name} has no catalog decision: add a worker entry or list it under libraries with a reason.`,
      );
    }
  }

  return violations;
}

function main() {
  const catalog = loadCatalog();
  const packages = loadPackages();
  const violations = evaluateCatalog({ catalog, packages });

  if (violations.length > 0) {
    stdout.write("Catalog gate FAILED:\n");
    for (const v of violations) stdout.write(`  ✗ ${v}\n`);
    stdout.write(
      "\nFix catalog.json (see spec/catalog.md and catalog.schema.json).\n",
    );
    exit(1);
  }

  stdout.write(
    `Catalog gate passed: ${catalog.workers.length} workers, ` +
      `${Object.keys(catalog.libraries ?? {}).length} libraries, ` +
      `${packages.length} workspace packages covered.\n`,
  );
  exit(0);
}

// Run only when invoked directly, not when imported by the test.
if (fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
