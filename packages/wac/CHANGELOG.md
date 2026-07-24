# @dwk/wac

## 0.1.0-beta.4

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/rdf@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- 3e505be: `evaluateAccess`'s second parameter is now a single `AclResource` (the
  effective ACL) instead of an `AclResource[]` chain of which only the first
  entry was ever consulted — the array shape implied a multi-entry walk that
  never happened. Callers passing `[acl]` now pass `acl` directly.

  Also documents (with a regression test) that a subject granting
  `acl:mode`/`acl:agent`/etc. without an explicit `rdf:type acl:Authorization`
  triple is not treated as an authorization — a conscious, fail-closed choice,
  not an oversight.

- Updated dependencies [3e505be]
  - @dwk/rdf@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/rdf@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/rdf@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
- a3fa4ff: Implement Web Access Control evaluation with `evaluateAccess`: effective-ACL walk honoring `acl:default` inheritance with `accessTo` precedence, `acl:Read`/`Write`/`Append`/`Control` modes, `acl:agent`/`agentGroup`/`agentClass` (incl. `foaf:Agent` and `acl:AuthenticatedAgent`), `acl:origin` allow-lists, and the Append-vs-Write boundary.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- 0253558: Fix a fail-open hazard in the effective-ACL walk and harden agent/origin
  matching. `evaluateAccess` previously skipped any ACL document whose
  authorizations did not apply to the target, so a resource's own `.acl` that
  existed but granted nothing for the request fell through to a permissive
  ancestor `acl:default`. A resource's own ACL (scope `"accessTo"`) is now
  implicitly authoritative — it stops the walk (granted or denied) without
  climbing, so an own ACL can never inherit an ancestor default — and a new
  `present` flag on `AclResource` lets a caller mark an existing ancestor
  `default` document authoritative as well. Additionally, an
  empty-string `agent` is no longer treated as authenticated (it can no longer
  satisfy `acl:AuthenticatedAgent` or match an empty `acl:agent`), and `acl:origin`
  comparisons normalize both sides via `URL` so case and trailing-slash
  differences do not defeat a correctly-configured allow-list.
- ec90b5f: Fix the effective-ACL stop condition to match WAC §5.1. `evaluateAccess`
  previously climbed past an existing-but-non-matching ancestor `acl:default`
  document (unless it was flagged `present`), which inverts the spec: §5.1 selects
  the _first_ ancestor whose ACL resource exists as the effective ACL "regardless
  of whether it contains matching authorizations", and that one document then
  makes a fail-closed decision. The chain already lists only existing ACL
  documents nearest-first, so its first entry is now treated as the authoritative
  effective ACL — granted or denied — and the content-based climb is removed. This
  was not reachable through `@dwk/solid-pod` (which resolves and passes the single
  effective ACL itself), but was a correctness trap for any other caller. The
  now-redundant `AclResource.present` flag is removed.
- Updated dependencies [65cab2c]
- Updated dependencies [ac90fce]
- Updated dependencies [3a806d9]
- Updated dependencies [9224fd7]
  - @dwk/rdf@0.1.0-beta.0
