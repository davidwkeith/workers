/**
 * Unit tests for the catalog gate (scripts/catalog-gate.mjs, issue #255).
 *
 * Runs under Node's built-in test runner (`node --test`) so it needs no Workers
 * runtime and no extra dependencies. The CLI itself is exercised in CI by the
 * `catalog:check` step against the live catalog.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCatalog, loadCatalog } from "./catalog-gate.mjs";
import { loadPackages } from "./release-gate.mjs";

/** A minimal valid catalog + workspace pair the failure cases mutate. */
function fixture() {
  return {
    catalog: {
      workers: [
        {
          id: "webmention",
          package: "@dwk/webmention",
          displayName: "Webmentions",
          description: "Receive and verify webmentions for posts",
          group: "social",
          binding: {
            kind: "componentTied",
            componentIDs: ["webmention-form"],
          },
          resources: [
            { type: "queue", binding: "WEBMENTION_QUEUE", consumer: true },
            { type: "d1", binding: "WEBMENTION_INBOX", optional: true },
          ],
        },
        {
          id: "solid-pod",
          package: "@dwk/solid-pod",
          displayName: "Solid Pod",
          description: "Solid-compatible personal data store",
          group: "storage",
          binding: { kind: "settingsActivated" },
          resources: [
            {
              type: "durable-object",
              binding: "POD",
              className: "SolidPodObject",
              sqlite: true,
            },
            { type: "r2", binding: "BLOBS" },
          ],
        },
      ],
      libraries: {
        "@dwk/rdf": "Reusable library, not a mountable worker.",
      },
    },
    packages: [
      { name: "@dwk/webmention", version: "0.1.0-beta.2" },
      { name: "@dwk/solid-pod", version: "0.1.0-beta.2" },
      { name: "@dwk/rdf", version: "0.1.0-beta.2" },
    ],
  };
}

test("a well-formed catalog covering the workspace passes", () => {
  assert.deepEqual(evaluateCatalog(fixture()), []);
});

test("a missing workers array is a violation", () => {
  const violations = evaluateCatalog({
    catalog: {},
    packages: [],
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /workers/);
});

test("duplicate worker ids are a violation", () => {
  const input = fixture();
  input.catalog.workers[1].id = "webmention";
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /duplicate.*"webmention"/i);
});

test("ids must be kebab-case slugs", () => {
  const input = fixture();
  input.catalog.workers[0].id = "Webmention Endpoint";
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /id/);
});

test("displayName, description, and group must be non-empty", () => {
  const input = fixture();
  input.catalog.workers[0].displayName = "";
  delete input.catalog.workers[0].group;
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 2);
});

test("an unknown binding.kind is a violation", () => {
  const input = fixture();
  input.catalog.workers[1].binding = { kind: "always-on" };
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /binding\.kind/);
});

test("componentTied requires a non-empty componentIDs array", () => {
  const input = fixture();
  input.catalog.workers[0].binding = { kind: "componentTied" };
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /componentIDs/);
});

test("settingsActivated must not carry componentIDs", () => {
  const input = fixture();
  input.catalog.workers[1].binding = {
    kind: "settingsActivated",
    componentIDs: ["pod-browser"],
  };
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /componentIDs/);
});

test("an unknown resource type is a violation", () => {
  const input = fixture();
  input.catalog.workers[1].resources.push({
    type: "hyperdrive",
    binding: "DB",
  });
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /hyperdrive/);
});

test("a durable-object resource requires a className", () => {
  const input = fixture();
  delete input.catalog.workers[1].resources[0].className;
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /className/);
});

test("duplicate resource bindings within one entry are a violation", () => {
  const input = fixture();
  input.catalog.workers[1].resources.push({ type: "r2", binding: "BLOBS" });
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /BLOBS/);
});

test("requires must reference known catalog ids, never itself", () => {
  const input = fixture();
  input.catalog.workers[0].requires = ["indieauth"];
  input.catalog.workers[1].requires = ["solid-pod"];
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /indieauth/);
  assert.match(violations[1], /itself/);
});

test("a workspace package missing from both workers and libraries is a violation", () => {
  const input = fixture();
  input.packages.push({ name: "@dwk/dpop", version: "0.1.0-beta.2" });
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /@dwk\/dpop/);
});

test("a package listed as both a worker and a library is a violation", () => {
  const input = fixture();
  input.catalog.libraries["@dwk/webmention"] = "also a lib, apparently";
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /both/);
});

test("a worker entry naming a package outside the workspace is a violation", () => {
  const input = fixture();
  input.packages = input.packages.filter((p) => p.name !== "@dwk/solid-pod");
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /@dwk\/solid-pod/);
});

test("a libraries entry naming a package outside the workspace is a violation", () => {
  const input = fixture();
  input.catalog.libraries["@dwk/imaginary"] = "does not exist";
  const violations = evaluateCatalog(input);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /@dwk\/imaginary/);
});

test("a non-object libraries value (e.g. an array) is a violation", () => {
  const input = fixture();
  input.catalog.libraries = ["@dwk/rdf"];
  const violations = evaluateCatalog(input);
  // The bad shape itself, plus @dwk/rdf losing its catalog decision.
  assert.equal(violations.length, 2);
  assert.match(violations[0], /"libraries" must be an object/);
  assert.match(violations[1], /@dwk\/rdf/);
});

test("the live catalog.json validates against the live workspace", () => {
  const violations = evaluateCatalog({
    catalog: loadCatalog(),
    packages: loadPackages(),
  });
  assert.deepEqual(violations, []);
});
