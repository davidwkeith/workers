# Anglesite issue triage

Anglesite sites can opt in to reporting production errors from the `@dwk/*`
packages they run. The design and privacy rules are in
[Anglesite/Anglesite#2095](https://github.com/Anglesite/Anglesite/issues/2095),
with the full spec in the Anglesite repo at
`docs/superpowers/specs/2026-09-30-worker-issues-autofix-design.md`. This repo
receives the result: attributed, redacted issues, and an agent that triages
them. Tracking issue: [#529](https://github.com/davidwkeith/workers/issues/529).

## What arrives

A relay at `issues.anglesite.dwk.io` receives
[Workers Issues](https://developers.cloudflare.com/workers/observability/issues/)
webhooks from registered sites. It files an issue here only when the innermost
in-app stack frame is in a `@dwk/*` package and no site-owner code called into
it.

Each issue carries:

- the exception class (for example `TypeError`)
- stack frames from `@dwk/*` and the Anglesite template, as path, line and
  column only
- the occurrence count on the reporting site, plus first-seen and last-seen
  times
- the catalog commit the site was built from
- a hidden `anglesite-issues fingerprint=…` marker, which the relay uses to
  de-duplicate across sites

Issues never contain the error message, request data, logs, span attributes,
the site's address or its Cloudflare account.

The labels are `source:anglesite-issues` and `pkg:<name>`. For an issue that is
already open, the relay adds at most one "reported again" comment a day.

## What the agent does

[`.github/workflows/anglesite-issue-triage.yml`](../.github/workflows/anglesite-issue-triage.yml)
runs [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
when the relay's GitHub App opens a labelled issue. You can also start it by
hand: **Actions ▸ Anglesite issue triage ▸ Run workflow**, then enter the issue
number.

The agent reproduces the error with a failing colocated test. It then does one
of the following:

- **Fixes it.** Opens a PR (`fix(<name>): …`, a changeset, the full CI gate,
  `Fixes #N`) for a maintainer to review.
- **Finds it already fixed.** Points at the commit after the site's catalog
  commit that fixed it.
- **Traces it to site configuration.** Recommends closing the issue with the
  `config` label.
- **Can't reproduce it confidently.** Comments its diagnosis and adds
  `agent:needs-human`.

The agent never merges, closes issues or releases anything.

## Maintainer actions

| To                                          | Do                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ship a fix                                  | Review and merge the agent's PR. `Fixes #N` closes the issue.                              |
| Stop reports for a site-configuration error | Close the issue with the `config` label. The relay stops filing that fingerprint for good. |
| Handle a real bug the agent couldn't fix    | Keep `agent:needs-human` and fix it by hand.                                               |

If a fixed error happens again after its issue closed, the relay opens a new
issue that links back as a regression.

## Setup (one time)

1. **Install the relay's GitHub App** on this repo with Issues read and write
   permission only. The Anglesite spec, ▸ "Deploying the relay", covers creating
   it.
2. **Set the repository variable** `ANGLESITE_ISSUES_BOT` to that App's slug,
   without the `[bot]` suffix. While it's unset, the workflow never runs.
3. **Install the [Claude GitHub App](https://github.com/apps/claude)** on this
   repo. The workflow uses its token so the agent's PRs trigger CI; a PR opened
   with `GITHUB_TOKEN` would not.
4. **Add one of these secrets:** `CLAUDE_CODE_OAUTH_TOKEN` (from
   `claude setup-token`) or `ANTHROPIC_API_KEY`.
5. **Create the labels** `source:anglesite-issues`, `agent:needs-human` and
   `config`. The relay creates `pkg:<name>` labels as needed.
