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
 * Structurally validate one worker entry, appending to `violations`. Returns
 * the entry's declared resource binding names, for the trigger cross-check.
 * @param {any} entry
 * @param {string} label
 * @param {string[]} violations
 * @returns {Set<string>}
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

  const seenBindings = new Set();
  const resources = entry.resources;
  if (!Array.isArray(resources)) {
    violations.push(`${label}: "resources" must be an array (may be empty).`);
    return seenBindings;
  }
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
  return seenBindings;
}

/** Five whitespace-separated cron fields (the wrangler triggers.crons shape). */
const CRON_PATTERN = /^\S+ \S+ \S+ \S+ \S+$/;

/**
 * Structurally validate one entry's scheduled trigger claims (issue #265),
 * appending to `violations`. Returns the structurally-valid triggers for the
 * cross-entry shared-job (dedupe) consistency check.
 * @param {any} entry
 * @param {string} label
 * @param {Set<string>} resourceBindings
 * @param {string[]} violations
 * @returns {{ cron: string, dedupe: string | undefined }[]}
 */
function checkTriggers(entry, label, resourceBindings, violations) {
  if (entry.triggers === undefined) return [];
  if (!Array.isArray(entry.triggers)) {
    violations.push(`${label}: "triggers" must be an array when present.`);
    return [];
  }
  /** @type {{ cron: string, dedupe: string | undefined }[]} */
  const valid = [];
  const seenHandlers = new Set();
  for (const trigger of entry.triggers) {
    const where = `${label}: trigger ${JSON.stringify(trigger?.handler ?? "(missing handler)")}`;

    if (!isNonEmptyString(trigger?.handler)) {
      violations.push(
        `${where}: every trigger needs a "handler" identity (the factory export producing the scheduled handler).`,
      );
      continue;
    }
    if (seenHandlers.has(trigger.handler)) {
      violations.push(`${where}: duplicate trigger handler.`);
      continue;
    }
    seenHandlers.add(trigger.handler);

    if (!isNonEmptyString(trigger.cron) || !CRON_PATTERN.test(trigger.cron)) {
      violations.push(
        `${where}: "cron" must be a five-field cron expression (got ${JSON.stringify(trigger.cron)}).`,
      );
      continue;
    }

    if (trigger.bindings !== undefined) {
      if (
        !Array.isArray(trigger.bindings) ||
        trigger.bindings.length === 0 ||
        !trigger.bindings.every(isNonEmptyString)
      ) {
        violations.push(
          `${where}: "bindings" must be a non-empty array of binding names when present.`,
        );
      } else {
        const seenTriggerBindings = new Set();
        for (const name of trigger.bindings) {
          if (seenTriggerBindings.has(name)) {
            violations.push(`${where}: duplicate trigger binding "${name}".`);
          }
          seenTriggerBindings.add(name);
          if (!resourceBindings.has(name)) {
            violations.push(
              `${where}: names binding "${name}" not declared in this worker's resources.`,
            );
          }
        }
      }
    }

    if (trigger.dedupe !== undefined && !isNonEmptyString(trigger.dedupe)) {
      violations.push(
        `${where}: "dedupe" must be a non-empty string when present.`,
      );
      continue;
    }
    valid.push({ cron: trigger.cron, dedupe: trigger.dedupe });
  }
  return valid;
}

/** Valid `match` values for a route claim. */
const ROUTE_MATCH_KINDS = new Set(["exact", "prefix"]);

/**
 * True when `path` is a well-formed absolute claim path: leading slash, no
 * empty inner segments, and no traversal segments (raw or percent-encoded).
 * @param {string} path
 */
function isCleanRoutePath(path) {
  const segments = path.slice(1).split("/");
  return segments.every((segment, index) => {
    if (segment === "") {
      // Only a trailing slash (the prefix form) may leave an empty segment.
      return index === segments.length - 1;
    }
    const decoded = segment.replace(/%2e/gi, ".");
    return decoded !== "." && decoded !== "..";
  });
}

/**
 * Structurally validate one entry's route claims (issue #256), appending to
 * `violations`. Returns the structurally-valid claims for cross-entry checks.
 * @param {any} entry
 * @param {string} label
 * @param {string[]} violations
 * @returns {{ path: string, match: string }[]}
 */
function checkRoutes(entry, label, violations) {
  if (entry.routes === undefined) return [];
  if (!Array.isArray(entry.routes)) {
    violations.push(`${label}: "routes" must be an array when present.`);
    return [];
  }
  /** @type {{ path: string, match: string }[]} */
  const valid = [];
  const seen = new Set();
  for (const route of entry.routes) {
    const where = `${label}: route ${JSON.stringify(route?.path ?? "(missing path)")}`;

    if (!isNonEmptyString(route?.path) || !route.path.startsWith("/")) {
      violations.push(`${where}: "path" must be an absolute path.`);
      continue;
    }
    if (!isCleanRoutePath(route.path)) {
      violations.push(
        `${where}: path must not contain traversal or empty segments.`,
      );
      continue;
    }
    if (!ROUTE_MATCH_KINDS.has(route.match)) {
      violations.push(
        `${where}: "match" must be "exact" or "prefix" (got ${JSON.stringify(route.match)}).`,
      );
      continue;
    }
    if (route.match === "prefix" && !route.path.endsWith("/")) {
      violations.push(`${where}: a prefix path needs a trailing slash.`);
      continue;
    }

    const methods = route.methods;
    if (!Array.isArray(methods) || methods.length === 0) {
      violations.push(`${where}: "methods" must be a non-empty array.`);
    } else {
      for (const method of methods) {
        if (method === "HEAD") {
          violations.push(
            `${where}: declare HEAD support via "head": true, not in methods.`,
          );
        } else if (
          typeof method !== "string" ||
          !/^[A-Z][A-Z-]*$/.test(method)
        ) {
          violations.push(
            `${where}: method ${JSON.stringify(method)} must be an uppercase HTTP token.`,
          );
        }
      }
    }
    if (
      route.head === true &&
      (!Array.isArray(methods) || !methods.includes("GET"))
    ) {
      violations.push(
        `${where}: "head": true requires GET among the methods (HEAD mirrors GET).`,
      );
    }
    if (!isNonEmptyString(route.handler)) {
      violations.push(
        `${where}: every route claim needs a "handler" identity (the factory export that owns it).`,
      );
    }

    const key = `${route.match} ${route.path}`;
    if (seen.has(key)) {
      violations.push(`${where}: duplicate claim (${key}).`);
      continue;
    }
    seen.add(key);
    valid.push({ path: route.path, match: route.match });
  }
  return valid;
}

/**
 * True when two claims overlap: equal exact paths, an exact path under the
 * other's prefix, or nested/equal prefixes.
 * @param {{ path: string, match: string }} ra
 * @param {{ path: string, match: string }} rb
 */
function claimsClash(ra, rb) {
  if (ra.match === "exact" && rb.match === "exact") {
    return ra.path === rb.path;
  }
  if (ra.match === "prefix" && rb.match === "prefix") {
    return ra.path.startsWith(rb.path) || rb.path.startsWith(ra.path);
  }
  const exact = ra.match === "exact" ? ra : rb;
  const prefix = ra.match === "exact" ? rb : ra;
  return exact.path.startsWith(prefix.path);
}

/**
 * Flag overlapping claims across two different workers. Claims within one
 * worker may overlap (its handler does its own sub-routing).
 * @param {{ id: string, routes: { path: string, match: string }[] }} a
 * @param {{ id: string, routes: { path: string, match: string }[] }} b
 * @param {string[]} violations
 */
function checkRouteOverlap(a, b, violations) {
  for (const ra of a.routes) {
    for (const rb of b.routes) {
      if (claimsClash(ra, rb)) {
        violations.push(
          `route claims overlap across workers "${a.id}" (${ra.match} ${ra.path}) and "${b.id}" (${rb.match} ${rb.path}).`,
        );
      }
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
  /** @type {{ id: string, routes: { path: string, match: string }[] }[]} */
  const routed = [];
  /** @type {Map<string, { id: string, cron: string }>} */
  const sharedJobs = new Map();

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

    const resourceBindings = checkEntry(entry, label, violations);
    const routes = checkRoutes(entry, label, violations);
    if (routes.length > 0) {
      routed.push({ id: String(entry?.id), routes });
    }

    // Shared-job triggers (equal dedupe keys) compose to one cron entry, so
    // their schedules must agree across workers.
    for (const trigger of checkTriggers(
      entry,
      label,
      resourceBindings,
      violations,
    )) {
      if (trigger.dedupe === undefined) continue;
      const entryId = entry?.id ?? "(missing id)";
      const prior = sharedJobs.get(trigger.dedupe);
      if (prior === undefined) {
        sharedJobs.set(trigger.dedupe, { id: entryId, cron: trigger.cron });
      } else if (prior.cron !== trigger.cron) {
        violations.push(
          `shared trigger "${trigger.dedupe}": workers "${prior.id}" ("${prior.cron}") and "${entryId}" ("${trigger.cron}") must declare the same cron expression.`,
        );
      }
    }
  }

  // Route claims must not overlap across workers (issue #256): the composing
  // app resolves each request to exactly one active worker.
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      checkRouteOverlap(routed[i], routed[j], violations);
    }
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
