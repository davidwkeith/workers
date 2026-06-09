/**
 * Unit tests for the release gate (scripts/release-gate.mjs).
 *
 * Runs under Node's built-in test runner (`node --test`) so it needs no Workers
 * runtime and no extra dependencies. The CLI itself is exercised in CI by the
 * `release:gate` step against the live conformance/status.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStable,
  parseVersion,
  evaluateReleaseGate,
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

test("isStable: only >=1.0.0 non-prerelease counts", () => {
  assert.equal(isStable("0.0.0"), false);
  assert.equal(isStable("0.9.9"), false);
  assert.equal(isStable("1.0.0-rc.1"), false);
  assert.equal(isStable("1.0.0"), true);
  assert.equal(isStable("2.4.1"), true);
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
          suites: {},
          integration: { status: "not-applicable" },
        },
      },
    },
  });
  assert.deepEqual(violations, []);
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
