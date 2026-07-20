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
