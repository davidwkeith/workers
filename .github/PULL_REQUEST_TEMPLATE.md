<!--
PR title must be Conventional Commits style: type(scope): subject
(lowercase type, scope = package name minus "@dwk/", no capitalized subject).
This repo squash-merges, so the PR title becomes the permanent git log entry.
  Correct:   fix(solid-pod): strip client-forged ldp:contains from container PUT
  Incorrect: Fix solid-pod: strip client-forged ldp:contains from container PUT
  Incorrect: Add AGENTS.md symlink to CLAUDE.md (missing type prefix)

Keep this template's section headings as-is (don't rename "Checklist" to
"Verification", don't collapse it into prose). Leave inapplicable checklist
items unchecked with a one-line reason instead of deleting them.
-->

## Summary

<!-- What does this PR change, and why? Link the relevant issue if there is one. -->

## Packages affected

<!-- e.g. @dwk/solid-pod, @dwk/store -->

## Checklist

- [ ] Read the relevant spec(s) under `spec/packages/` and updated them if
      behaviour changed
- [ ] Added/updated colocated tests (`src/*.test.ts`)
- [ ] Ran the local CI gate: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`
- [ ] Added a changeset (`pnpm changeset`) if this touches a publishable
      package
- [ ] Updated `catalog.json` / `conformance/status.json` if this adds a new
      mountable worker or changes conformance status
