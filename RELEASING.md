# Releasing

How the `@dwk/*` packages get published to npm. Read this before cutting a
release — the repo is in a **Changesets pre-release ("beta") mode** that changes
the normal flow, and there are a couple of non-obvious npm behaviours documented
at the bottom.

## TL;DR

1. Record changes as you go: `pnpm changeset` (commit the generated `.changeset/*.md`).
2. Version locally: `pnpm changeset version` → commit the bumps + changelogs.
3. Push to `main`.
4. **Dry run** the publish: Actions → **Release** → Run workflow → `dry_run: true`.
5. **Publish**: same workflow with `dry_run: false`.
6. Verify on npm and confirm the git tags landed on origin.

You never run `pnpm release` / `changeset publish` from a laptop — publishing
happens only through the gated **Release** GitHub Actions workflow.

## The setup (what's already wired up)

- **Changesets**, independent semver per package. Config in `.changeset/config.json`
  (`access: public`, `commit: false`, changelog via `@changesets/cli/changelog`).
- **Pre mode is active.** `.changeset/pre.json` exists with `tag: beta`, so every
  package currently sits at `0.1.0-beta.N`. Nothing has hit a stable `1.0.0` yet.
  **Dist-tag caveat:** despite the `beta` pre-mode tag, `changeset publish`
  publishes packages that have _never had a stable release_ to the **`latest`**
  dist-tag, not `beta` (see the "Dist-tags" gotcha below). So until a `1.0.0`
  ships, `latest` tracks the newest beta and plain `npm i @dwk/<pkg>` installs it.
- **Release gate.** `pnpm release:gate` (`scripts/release-gate.mjs`) blocks any
  package at a **stable** version (`major >= 1`, no prerelease tag) whose
  conformance/integration status in `conformance/status.json` isn't `passing` or
  `not-applicable`. Prerelease (`-beta.N`) versions are **exempt**, so the gate
  passes today. It also skips `"private": true` packages.
- **`pnpm release`** = `release:gate` → `pnpm build` → `changeset publish`.
- **CI publish workflow** `.github/workflows/release.yml`:
  - Manual `workflow_dispatch` only, with a `dry_run` boolean input.
  - Runs the full CI gate (lint → format:check → typecheck → **build → test**)
    before publishing — build precedes test because package tests import sibling
    `@dwk/*` deps through their `exports` map (`dist/`).
  - Runs in the **`npm-publish`** GitHub Environment, which holds the
    `NPM_TOKEN` secret and any protection rules (required reviewers, allowed
    branches). The environment is gated to the `main` branch.
  - Publishes with **provenance** (`id-token: write` + `NPM_CONFIG_PROVENANCE`),
    then tags origin by re-deriving `name@version` tags from each non-private
    `package.json` and pushing (changeset's own tags don't survive the step —
    see the gotcha).
- **`@dwk/server` is `"private": true`** — the Node/Express self-hosting host
  ships only as a Docker image and is never published to npm.

### Prerequisites (one-time)

- Repo secret **`NPM_TOKEN`** on the `npm-publish` environment: an npm
  **automation** or **granular** token with publish rights to the `@dwk` scope.
  Automation tokens bypass 2FA prompts (essential for CI).
- The `npm-publish` environment must allow the `main` branch (so a
  `workflow_dispatch` from `main` isn't rejected).

## Cutting a beta release (the routine path)

1. **Record changesets** for the work (if not already done):

   ```bash
   pnpm changeset          # pick affected packages + bump type; commit the .md
   ```

2. **Apply versions locally.** In pre mode this bumps `0.1.0-beta.N` →
   `0.1.0-beta.(N+1)`, consumes the pending changesets into `pre.json`, and
   writes CHANGELOGs:

   ```bash
   pnpm changeset version
   git add -A && git commit -m "chore(release): version packages"
   git push origin main      # or via PR
   ```

3. **Dry run the workflow** (build + full gate, no publish):

   ```bash
   gh workflow run release.yml -f dry_run=true --ref main
   gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

   Expect green, with **Publish to npm** and **Push release tags** _skipped_.

4. **Publish for real:**

   ```bash
   gh workflow run release.yml -f dry_run=false --ref main
   ```

   Watch it; the same two steps now _run_. `changeset publish` publishes each
   package whose local version isn't yet on npm (to the `latest` dist-tag while
   no stable release exists — see the dist-tag caveat above).

5. **Verify** (see below).

## Cutting a stable release (exiting beta)

When the packages are ready for a real `>=1.0.0` on the `latest` tag:

1. Make sure each package you're stabilising is green in
   `conformance/status.json` (the gate enforces this for stable versions).
2. Exit pre mode and re-version:

   ```bash
   pnpm changeset pre exit          # removes pre.json
   pnpm changeset version           # collapses the betas into the next stable
   git add -A && git commit -m "chore(release): 1.0.0"
   git push origin main
   ```

3. Dry run, then publish, exactly as above. Now `changeset publish` targets the
   **`latest`** dist-tag, and `release:gate` will fail the run if any stable
   package is non-conformant.

To start a _new_ prerelease line later: `pnpm changeset pre enter beta` (or
`next`, `rc`, …).

## Verifying a publish

```bash
# Each package on the expected dist-tag (registry is authoritative):
for p in dpop rdf log store wac solid-pod activitypub micropub microsub \
         indieauth webmention websub webfinger host-meta webauthn vc ldn \
         oauth http-signatures remotestorage; do
  printf '%-22s beta=%s latest=%s\n' "@dwk/$p" \
    "$(npm view @dwk/$p dist-tags.beta 2>/dev/null)" \
    "$(npm view @dwk/$p dist-tags.latest 2>/dev/null)"
done

# @dwk/server must NOT exist (private):
npm view @dwk/server version            # expect E404

# Git tags reached origin:
git ls-remote --tags origin | grep -c '@dwk'   # expect 20
```

The meaningful tag pre-1.0 is **`latest`** — it should equal the version you just
released (`beta` stays pinned at `0.1.0-beta.0` and is not advanced; see the
dist-tag gotcha). If `npm view` 404s or shows the old version for a package you
_just_ published, give it a minute — registry GET-propagation lags. Confirm the
run's **Publish to npm** step listed it as `published successfully`, and check the
published **version list** (`npm view @dwk/<pkg> versions`) which updates before
the dist-tag pointer does.

## Gotchas (learned the hard way)

- **Registry GET-propagation can lag several minutes.** Immediately after a
  successful publish, `npm view` / a direct `curl https://registry.npmjs.org/...`
  may 404 for minutes even though the publish succeeded. Sanity-check your read
  path against a known-public package (e.g. `@types/node` → 200) before
  concluding a publish failed. Trust the workflow's `published successfully`
  line first.
- **Dist-tags: betas land on `latest`, not `beta`.** In pre mode, `changeset
publish` sends packages that have _never had a stable release_ to the `latest`
  dist-tag (it only uses the pre-mode `beta` tag for packages that already have a
  normal release). Since none of ours do, every beta publishes to `latest`, and
  the `beta` tag stays frozen at `0.1.0-beta.0` (a leftover from the first
  publish). **Net effect pre-1.0:** the install channel is plain
  `npm i @dwk/<pkg>` (→ newest beta); `@dwk/<pkg>@beta` is stale — don't advertise
  it. This self-corrects on `pre exit` + `1.0.0`, when `latest` moves to the
  stable. We deliberately do **not** maintain the `beta` tag in the meantime.
- **Changeset's git tags don't survive to the push step.** `changeset publish`
  logs `New tag: ...` but those lightweight tags are not present when the next
  workflow step runs (`git push origin --tags` → "Everything up-to-date"), so the
  workflow instead **re-derives** `name@version` tags from each non-private
  `package.json` and pushes those. If a release's tags ever go missing, recreate
  them at the publish commit and push:
  `git tag "@dwk/<pkg>@<version>" <sha> && git push origin "refs/tags/@dwk/*"`.
- **`changeset publish` is a no-op for already-published versions.** Re-running a
  publish without bumping versions publishes nothing and still exits 0. Bump
  versions (`changeset version`) first.
- **Build before test.** Any CI step that runs the test suite must build first;
  vitest resolves sibling `@dwk/*` deps through their `dist/` `exports`.

## Related

- `CLAUDE.md` → "Conformance & release gate" and the commands table.
- `spec/conformance-and-testing.md` — the conformance bar for stable releases.
- `.github/workflows/release.yml` — the publish workflow.
- `.github/workflows/conformance.yml` — release-gate + integration on every PR;
  hosted suites on schedule/dispatch.
