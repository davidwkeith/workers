/**
 * Publish-side guard for the Anglesite issue triage workflow (#529).
 *
 * The triage agent runs with a read-only token and untrusted input: frames and
 * exception classes from production errors that the Anglesite relay filed. It
 * never pushes. It leaves an `.agent/result.json` and edits in its own
 * workspace. The workflow's separate `publish` job copies only allowlisted
 * paths into a clean checkout and asks this script what it may do.
 *
 * Every check that keeps the agent's output away from `.github/`, scripts,
 * package manifests and other packages lives here, enforced mechanically
 * rather than by prompt.
 *
 * Pure and importable: `planPublish` is unit-tested by
 * scripts/anglesite-triage.test.mjs without spawning the CLI.
 *
 * Usage (from the workflow):
 *   node scripts/anglesite-triage.mjs <result.json> <changed-paths.txt> <issue-number>
 * Prints a JSON plan on stdout. The workflow executes it with fixed commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdout } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const OUTCOMES = new Set([
  "fix",
  "already-fixed",
  "config",
  "needs-human",
]);
const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TITLE = /^fix\(([a-z0-9][a-z0-9-]{0,63})\): [^\n\r]{1,90}$/;
const CHANGESET = /^\.changeset\/[a-z0-9][a-z0-9-]{0,80}\.md$/;
const MAX_SUMMARY = 6000;

/**
 * Validates the agent's result file. Anything malformed becomes a
 * `needs-human` plan rather than an error, so a confused or manipulated agent
 * still ends in a visible comment, never in a silent failure or a push.
 */
export function parseResult(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: "result.json is not valid JSON" };
  }
  if (!value || typeof value !== "object")
    return { ok: false, reason: "result.json is not an object" };
  const { outcome, package: pkg, title, summary } = value;
  if (!OUTCOMES.has(outcome))
    return { ok: false, reason: `unknown outcome ${JSON.stringify(outcome)}` };
  if (typeof summary !== "string" || summary.trim() === "")
    return { ok: false, reason: "summary is missing" };
  if (outcome === "fix") {
    if (typeof pkg !== "string" || !PACKAGE_NAME.test(pkg))
      return { ok: false, reason: "fix without a valid package" };
    const match = typeof title === "string" ? title.match(TITLE) : null;
    if (!match || match[1] !== pkg)
      return {
        ok: false,
        reason: "fix title must be `fix(<package>): …` for the fixed package",
      };
  }
  return {
    ok: true,
    outcome,
    pkg,
    title,
    summary: summary.slice(0, MAX_SUMMARY),
  };
}

/**
 * The only paths a fix may touch: the one package's `src/`, plus new changeset
 * files. Never the changeset config or README, `.github/`, `scripts/`,
 * manifests, lockfiles, or another package.
 */
export function checkPaths(paths, pkg) {
  const srcPrefix = `packages/${pkg}/src/`;
  const rejected = paths.filter(
    (p) =>
      p.includes("..") ||
      !(
        p.startsWith(srcPrefix) ||
        (CHANGESET.test(p) && p !== ".changeset/README.md")
      ),
  );
  const sourceChanges = paths.filter((p) => p.startsWith(srcPrefix));
  const changesets = paths.filter(
    (p) => CHANGESET.test(p) && p !== ".changeset/README.md",
  );
  return { rejected, sourceChanges, changesets };
}

/** Stops agent-written text pinging people: `@name` gets a zero-width space. */
export function neutralizeMentions(text) {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@​");
}

/**
 * Turns the agent's result and the changed paths into what the publish job may
 * do: commit and open a PR, comment, which labels to add.
 */
export function planPublish({
  rawResult,
  changedPaths,
  issueNumber,
  packageExists = () => true,
}) {
  const result = parseResult(rawResult);
  const header = "🤖 **Anglesite issue triage**";
  const footer =
    "\n\n<sub>Automated by `.github/workflows/anglesite-issue-triage.yml`. A maintainer reviews every change.</sub>";
  const needsHuman = (why, detail = "") => ({
    commit: false,
    labels: ["agent:triaged", "agent:needs-human"],
    comment: `${header}: needs a maintainer — ${why}.${detail ? `\n\n${neutralizeMentions(detail)}` : ""}${footer}`,
  });

  if (!result.ok)
    return needsHuman(`the agent's result was rejected (${result.reason})`);
  const summary = neutralizeMentions(result.summary);

  if (result.outcome !== "fix") {
    if (changedPaths.length > 0 && result.outcome !== "needs-human") {
      return needsHuman(
        "the agent changed files without proposing a fix",
        summary,
      );
    }
    const labels = [
      "agent:triaged",
      ...(result.outcome === "needs-human" ? ["agent:needs-human"] : []),
    ];
    const lead = {
      "already-fixed": "already fixed on `main`",
      config:
        "looks like site configuration, not a package bug. If you agree, close this issue with the `config` label so the relay stops filing it",
      "needs-human": "needs a maintainer",
    }[result.outcome];
    return {
      commit: false,
      labels,
      comment: `${header}: ${lead}.\n\n${summary}${footer}`,
    };
  }

  if (!packageExists(result.pkg))
    return needsHuman(`package \`${result.pkg}\` doesn't exist`, summary);
  const { rejected, sourceChanges, changesets } = checkPaths(
    changedPaths,
    result.pkg,
  );
  if (rejected.length > 0) {
    return needsHuman(
      `the proposed fix touched files outside \`packages/${result.pkg}/src/\` and new changesets, so it was not published`,
      `Rejected paths:\n${rejected.map((p) => `- \`${p.replace(/`/g, "")}\``).join("\n")}\n\n${summary}`,
    );
  }
  if (sourceChanges.length === 0)
    return needsHuman(
      "the agent proposed a fix but changed no source",
      summary,
    );
  if (changesets.length === 0)
    return needsHuman("the proposed fix has no changeset", summary);

  const branch = `agent/anglesite-issue-${issueNumber}`;
  const prBody = [
    "## Summary",
    "",
    `Fixes #${issueNumber}. Proposed by the Anglesite issue triage agent; review it like any other contribution.`,
    "",
    summary,
    "",
    "## Packages affected",
    "",
    `@dwk/${result.pkg}`,
    "",
    "## Checklist",
    "",
    "- [ ] Read the relevant spec(s) under `spec/packages/` and updated them if behaviour changed. Reviewer to confirm.",
    "- [x] Added/updated colocated tests (`src/*.test.ts`): the agent adds a reproducing test.",
    "- [ ] Ran the local CI gate: CI runs it on this branch (dispatched by the triage workflow).",
    "- [x] Added a changeset (`pnpm changeset`) if this touches a publishable package.",
    "- [ ] Updated `catalog.json` / `conformance/status.json`: N/A, agent fixes can't touch them.",
    footer.trim(),
  ].join("\n");
  return {
    commit: true,
    branch,
    title: result.title,
    prBody,
    labels: ["agent:triaged"],
    comment: `${header}: proposed a fix in a pull request from \`${branch}\`.\n\n${summary}${footer}`,
  };
}

function main() {
  const [resultPath, pathsFile, issueNumber] = argv.slice(2);
  if (!resultPath || !pathsFile || !/^[0-9]+$/.test(issueNumber ?? "")) {
    console.error(
      "usage: anglesite-triage.mjs <result.json> <changed-paths.txt> <issue-number>",
    );
    exit(2);
  }
  const rawResult = existsSync(resultPath)
    ? readFileSync(resultPath, "utf8")
    : "";
  const changedPaths = readFileSync(pathsFile, "utf8")
    .split("\n")
    .filter(Boolean);
  const plan = planPublish({
    rawResult,
    changedPaths,
    issueNumber,
    packageExists: (pkg) =>
      existsSync(join(ROOT, "packages", pkg, "package.json")),
  });
  stdout.write(`${JSON.stringify(plan)}\n`);
}

if (import.meta.url === `file://${argv[1]}`) main();
