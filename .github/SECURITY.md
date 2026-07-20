# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead,
use [GitHub private vulnerability reporting](https://github.com/davidwkeith/workers/security/advisories/new)
to report it privately. Include:

- The package(s) and version(s) affected (this is a monorepo of independently
  versioned `@dwk/*` packages — see [`RELEASING.md`](../RELEASING.md)).
- Reproduction steps or a proof of concept.
- The potential impact as you understand it.

You should receive an acknowledgement within a few days. We'll work with you
to understand and address the issue before any public disclosure.

## Supported versions

All `@dwk/*` packages are currently pre-1.0 (`0.1.0-beta.N`, see
[`.changeset/pre.json`](../.changeset/pre.json)). Security fixes land on the
latest prerelease of each affected package; there are no older maintained
release lines yet.

## Scope

This project ships as source packages that end users deploy to their **own**
Cloudflare account — there is no hosted service operated by this project to
report infrastructure issues against. Vulnerability reports should concern the
code in this repository (e.g. authz bypass, injection, SSRF, token handling)
rather than a deployed instance you don't control.
