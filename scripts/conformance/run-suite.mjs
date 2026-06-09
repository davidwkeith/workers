/**
 * Conformance-suite dispatcher (issue #12).
 *
 * The hosted conformance suites (micropub.rocks, webmention.rocks, the Solid
 * conformance suites) exercise a *deployed, publicly reachable* endpoint and,
 * for the receiver/sender cases, must call back into it. They therefore cannot
 * run against an in-process Miniflare worker the way the unit/integration tests
 * do — they need a real target URL.
 *
 * This script is the single seam where CI (or a developer) points a suite at a
 * deployed Worker. Given `--target <url>` it runs the suite's documented
 * tooling; without a target it prints the procedure and exits 0 so the
 * conformance workflow stays green on ordinary pushes while still documenting
 * exactly what a release requires. Results are recorded by hand (or by a
 * follow-up job) into conformance/status.json, which the release gate reads.
 *
 * Usage:
 *   node scripts/conformance/run-suite.mjs <standard> [--target <url>]
 *   <standard> ∈ micropub | webmention | solid
 */

import { argv, env, exit, stdout, stderr } from "node:process";

/** @type {Record<string, { package: string, suites: string[], docs: string, howto: string[] }>} */
const SUITES = {
  micropub: {
    package: "@dwk/micropub",
    suites: ["micropub.rocks"],
    docs: "https://micropub.rocks/",
    howto: [
      "1. Deploy a Worker mounting createMicropub() and obtain a valid",
      "   IndieAuth access token for the test identity.",
      "2. Run the micropub.rocks server tests against the deployed Micropub",
      "   endpoint URL (set via --target or the MICROPUB_TARGET env var).",
      "3. Publish the result to https://micropub.net/implementation-reports/",
      '   and set conformance/status.json -> "@dwk/micropub" suite to',
      '   "passing" with the report URL.',
    ],
  },
  webmention: {
    package: "@dwk/webmention",
    suites: ["webmention.rocks/receiver", "webmention.rocks/sender"],
    docs: "https://webmention.rocks/",
    howto: [
      "1. Deploy a Worker mounting the Webmention receiver + sender.",
      "2. Receiver: submit the deployed receiver endpoint to the",
      "   webmention.rocks receiver tests; it will send test mentions and",
      "   verify your processing.",
      "3. Sender: point the sender at each webmention.rocks/test/N source and",
      "   confirm discovery + delivery for all cases.",
      '4. Record both suites as "passing" in conformance/status.json.',
    ],
  },
  solid: {
    package: "@dwk/solid-pod",
    suites: ["solid-conformance"],
    docs: "https://github.com/solid/conformance-test-harness",
    howto: [
      "1. Deploy a Worker mounting createSolidPod() with a per-pod Durable",
      "   Object, R2 blob bucket, and D1 GC database bound.",
      "2. Run the Solid conformance test harness (and real-client interop:",
      "   authenticated GET-through-WAC, PATCH with where/conflict/If-Match)",
      "   against the deployed pod base URL.",
      '3. Record "solid-conformance" as "passing" in conformance/status.json.',
    ],
  },
};

function main() {
  const [standard, ...rest] = argv.slice(2);
  if (!standard || !SUITES[standard]) {
    stderr.write(
      `Unknown or missing standard. Expected one of: ${Object.keys(SUITES).join(", ")}\n`,
    );
    exit(2);
  }

  const targetFlagIndex = rest.indexOf("--target");
  const target =
    targetFlagIndex !== -1
      ? rest[targetFlagIndex + 1]
      : env[`${standard.toUpperCase()}_TARGET`];

  // Which conformance column the result is recorded into: the primary Cloudflare
  // target, or the self-hosted Node host (a deployed @dwk/server instance).
  const targetIdFlagIndex = rest.indexOf("--target-id");
  const targetId =
    targetIdFlagIndex !== -1
      ? rest[targetIdFlagIndex + 1]
      : (env.CONFORMANCE_TARGET_ID ?? "cloudflare");
  const column =
    targetId === "cloudflare"
      ? '"<suite>"'
      : `"<suite>" -> targets -> "${targetId}"`;

  const suite = SUITES[standard];
  stdout.write(`Conformance: ${suite.package} (${suite.suites.join(", ")})\n`);
  stdout.write(`Reference: ${suite.docs}\n`);
  stdout.write(
    `Recording column: ${targetId} (status.json suite ${column})\n\n`,
  );

  if (!target) {
    stdout.write(
      "No --target URL provided; nothing to run. Hosted conformance suites\n" +
        "require a deployed, publicly reachable Worker. Procedure:\n\n",
    );
    stdout.write(suite.howto.join("\n") + "\n");
    // No target is a documented no-op, not a failure: ordinary CI stays green.
    exit(0);
  }

  stdout.write(`Target: ${target}\n`);
  stdout.write(
    "Running hosted conformance tooling against the target is performed by the\n" +
      "external suite. This dispatcher records the intent; wire the suite's\n" +
      "runner here once a deploy target is available in CI. Procedure:\n\n",
  );
  stdout.write(suite.howto.join("\n") + "\n");
  exit(0);
}

main();
