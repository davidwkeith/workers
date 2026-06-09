---
"@dwk/server": patch
---

Track the self-hosted Node host as its own conformance target. `conformance/status.json`
(and its schema) gain a per-target dimension: a top-level `targets` declaration
(`cloudflare` primary, `node` self-host) and an optional `targets` map on each
suite/integration block, plus an `@dwk/server` package row. The release gate now
validates every declared target for stable packages, the report shows the Node
column, and `run-suite.mjs --target-id node` records hosted results into it. The
Node host's integration lifecycle is recorded `passing` for the packages the
`@dwk/server` integration tests bring up end to end; a `docker.yml` workflow
builds/publishes the image on release. `@dwk/server` stays experimental until its
hosted conformance column is green.
