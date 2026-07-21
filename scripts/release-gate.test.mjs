/**
 * Unit tests for the release gate (scripts/release-gate.mjs).
 *
 * Runs under Node's built-in test runner (`node --test`) so it needs no Workers
 * runtime and no extra dependencies. The CLI itself is exercised in CI by the
 * `release:gate` step against the live conformance/status.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStable,
  parseVersion,
  evaluateReleaseGate,
  loadPackages,
} from "./release-gate.mjs";

test("parseVersion handles release and prerelease versions", () => {
  assert.deepEqual(parseVersion("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: null,
  });
  assert.equal(parseVersion("1.0.0-rc.1").prerelease, "rc.1");
  assert.equal(parseVersion("not-a-version"), null);
});

test("parseVersion rejects a version with trailing garbage (regex must be end-anchored)", () => {
  assert.equal(parseVersion("1.0.0garbage"), null);
});

test("isStable: only >=1.0.0 non-prerelease counts", () => {
  assert.equal(isStable("0.0.0"), false);
  assert.equal(isStable("0.9.9"), false);
  assert.equal(isStable("1.0.0-rc.1"), false);
  assert.equal(isStable("1.0.0"), true);
  assert.equal(isStable("2.4.1"), true);
});

test("isStable: trailing garbage after a valid-looking version does not count as stable", () => {
  // Before the parseVersion anchor fix, this incorrectly returned true.
  assert.equal(isStable("1.0.0garbage"), false);
});

test("loadPackages throws on a package.json that isn't valid JSON, rather than silently skipping it", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-test-"));
  try {
    mkdirSync(join(dir, "packages", "broken"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "broken", "package.json"),
      "{ not valid json",
    );
    assert.throws(() => loadPackages(dir), /is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPackages throws on a non-private package.json missing name/version, rather than silently skipping it", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-test-"));
  try {
    mkdirSync(join(dir, "packages", "incomplete"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "incomplete", "package.json"),
      JSON.stringify({ description: "no name or version" }),
    );
    assert.throws(
      () => loadPackages(dir),
      /missing a string `name`\/`version`/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPackages skips a private package.json missing name/version, and a directory with no package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-gate-test-"));
  try {
    mkdirSync(join(dir, "packages", "private-pkg"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "private-pkg", "package.json"),
      JSON.stringify({ private: true }),
    );
    mkdirSync(join(dir, "packages", "not-a-package"), { recursive: true });
    assert.deepEqual(loadPackages(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0.x packages are exempt regardless of conformance status", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "0.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: { "micropub.rocks": { status: "pending" } },
          integration: { status: "pending" },
        },
      },
    },
  });
  assert.deepEqual(violations, []);
});

test("a stable package with passing suites + integration passes the gate", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: { "micropub.rocks": { status: "passing" } },
          integration: { status: "passing" },
        },
      },
    },
  });
  assert.deepEqual(violations, []);
});

test("a stable package with a pending suite is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: { "micropub.rocks": { status: "pending" } },
          integration: { status: "passing" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /micropub\.rocks/);
});

test("a stable package with failing integration tests is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/solid-pod", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/solid-pod": {
          suites: { "solid-conformance": { status: "passing" } },
          integration: { status: "failing" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /integration lifecycle/);
});

test("a stable package missing a status entry is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/mystery", version: "1.0.0" }],
    status: { packages: {} },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no conformance\/status\.json entry/);
});

test("a malformed (null) suite entry is flagged, not crashed on", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: { "micropub.rocks": null },
          integration: { status: "passing" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /micropub\.rocks/);
});

test('"not-applicable" suites and integration do not block', () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/dpop", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/dpop": {
          suites: { dummy: { status: "not-applicable" } },
          integration: { status: "not-applicable" },
        },
      },
    },
  });
  assert.deepEqual(violations, []);
});

test("a stable package with empty suites and not-applicable integration is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/mcp", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/mcp": {
          suites: {},
          integration: { status: "not-applicable" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no conformance suites/);
});

test("a stable package with pending suites is blocked even without not-applicable integration", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/calendar", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/calendar": {
          suites: {},
          integration: { status: "pending" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /pending/);
});

test("a major-version-2 stable package with empty suites and not-applicable integration is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/calendar", version: "2.0.0" }],
    status: {
      packages: {
        "@dwk/calendar": {
          suites: {},
          integration: { status: "not-applicable" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no conformance suites/);
});

test("a stable package with a pending per-target (node) suite is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: {
            "micropub.rocks": {
              status: "passing",
              targets: { node: { status: "pending" } },
            },
          },
          integration: { status: "passing" },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /target "node"/);
});

test("a stable package with a failing per-target (node) integration is blocked", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/solid-pod", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/solid-pod": {
          suites: { "solid-conformance": { status: "passing" } },
          integration: {
            status: "passing",
            targets: { node: { status: "failing" } },
          },
        },
      },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /integration lifecycle tests on target "node"/);
});

test("passing / not-applicable per-target results do not block", () => {
  const violations = evaluateReleaseGate({
    packages: [{ name: "@dwk/micropub", version: "1.0.0" }],
    status: {
      packages: {
        "@dwk/micropub": {
          suites: {
            "micropub.rocks": {
              status: "passing",
              targets: { node: { status: "passing" } },
            },
          },
          integration: {
            status: "passing",
            targets: { node: { status: "not-applicable" } },
          },
        },
      },
    },
  });
  assert.deepEqual(violations, []);
});
