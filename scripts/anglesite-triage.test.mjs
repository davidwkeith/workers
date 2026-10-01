import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPaths,
  neutralizeMentions,
  parseResult,
  planPublish,
} from "./anglesite-triage.mjs";

const fix = {
  outcome: "fix",
  package: "webmention",
  title: "fix(webmention): guard a missing source before verifying",
  summary: "Reproduced with a failing test; `source` can be undefined.",
};
const plan = (result, changedPaths = [], extra = {}) =>
  planPublish({
    rawResult: JSON.stringify(result),
    changedPaths,
    issueNumber: "42",
    ...extra,
  });

test("a valid fix in one package's src plus a changeset is published", () => {
  const p = plan(fix, [
    "packages/webmention/src/verify.ts",
    "packages/webmention/src/verify.test.ts",
    ".changeset/quiet-dogs-run.md",
  ]);
  assert.equal(p.commit, true);
  assert.equal(p.branch, "agent/anglesite-issue-42");
  assert.equal(p.title, fix.title);
  assert.deepEqual(p.labels, ["agent:triaged"]);
  assert.match(p.prBody, /^## Summary\n\nFixes #42\./);
  assert.match(p.prBody, /## Packages affected\n\n@dwk\/webmention/);
  assert.match(p.prBody, /## Checklist/);
});

for (const path of [
  ".github/workflows/ci.yml",
  "scripts/release-gate.mjs",
  "package.json",
  "packages/webmention/package.json",
  "packages/indieauth/src/index.ts",
  ".changeset/config.json",
  ".changeset/README.md",
  "pnpm-workspace.yaml",
  "packages/webmention/src/../../../.github/x.yml",
]) {
  test(`a fix touching ${path} is not published`, () => {
    const p = plan(fix, [
      "packages/webmention/src/verify.ts",
      ".changeset/a.md",
      path,
    ]);
    assert.equal(p.commit, false);
    assert.deepEqual(p.labels, ["agent:triaged", "agent:needs-human"]);
    assert.match(p.comment, /was not published/);
  });
}

test("a fix needs both a source change and a changeset", () => {
  assert.match(plan(fix, [".changeset/a.md"]).comment, /changed no source/);
  assert.match(
    plan(fix, ["packages/webmention/src/verify.ts"]).comment,
    /no changeset/,
  );
});

test("the fix title must name the fixed package", () => {
  const p = plan({ ...fix, title: "fix(indieauth): something" }, [
    "packages/webmention/src/verify.ts",
    ".changeset/a.md",
  ]);
  assert.equal(p.commit, false);
  assert.match(p.comment, /fix title/);
});

test("a nonexistent package is refused", () => {
  const p = plan(
    fix,
    ["packages/webmention/src/verify.ts", ".changeset/a.md"],
    { packageExists: () => false },
  );
  assert.equal(p.commit, false);
});

test("non-fix outcomes comment and label, and never commit", () => {
  const config = plan({
    outcome: "config",
    summary: "The site passes an empty source.",
  });
  assert.equal(config.commit, false);
  assert.deepEqual(config.labels, ["agent:triaged"]);
  assert.match(config.comment, /`config` label/);

  const human = plan(
    { outcome: "needs-human", summary: "Could not reproduce." },
    ["packages/webmention/src/x.test.ts"],
  );
  assert.deepEqual(human.labels, ["agent:triaged", "agent:needs-human"]);
});

test("a non-fix outcome that still changed files goes to a human", () => {
  const p = plan({ outcome: "already-fixed", summary: "Fixed in abc123." }, [
    "packages/webmention/src/verify.ts",
  ]);
  assert.deepEqual(p.labels, ["agent:triaged", "agent:needs-human"]);
});

test("a missing or malformed result becomes a needs-human comment", () => {
  for (const raw of [
    "",
    "not json",
    JSON.stringify({ outcome: "merge" }),
    JSON.stringify({ outcome: "fix", summary: "x" }),
  ]) {
    const p = planPublish({
      rawResult: raw,
      changedPaths: [],
      issueNumber: "1",
    });
    assert.equal(p.commit, false);
    assert.ok(p.labels.includes("agent:needs-human"), raw);
  }
});

test("agent-written text can't @-mention anyone", () => {
  assert.equal(
    neutralizeMentions("ping @davidwkeith and @org/team"),
    "ping @​davidwkeith and @​org/team",
  );
  const p = plan({ outcome: "needs-human", summary: "cc @davidwkeith" });
  assert.ok(!/@davidwkeith/.test(p.comment));
});

test("parseResult caps the summary length", () => {
  const r = parseResult({ outcome: "config", summary: "x".repeat(10000) });
  assert.equal(r.summary.length, 6000);
});

test("checkPaths reports exactly the out-of-bounds paths", () => {
  const { rejected } = checkPaths(
    ["packages/a/src/x.ts", "packages/b/src/y.ts", ".changeset/z.md"],
    "a",
  );
  assert.deepEqual(rejected, ["packages/b/src/y.ts"]);
});
