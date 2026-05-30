# Overview

## 1. Purpose

Owning your internet presence across open protocols today means either trusting
a hosted service or babysitting a server. This SDK provides the building blocks
to give *anyone* a self-owned, standards-compliant presence — IndieWeb
publishing/interaction now, a Solid Pod data vault next — running serverless on
infrastructure the user controls.

The deliverable is **not a hosted product, not a single Worker, and not a
one-off "suite."** `@dwk` is the npm scope/branding under which standards
packages live, and more will follow for other standards. This cohort scopes
only the **IndieWeb + Solid** packages: a developer can `npm install` any of
them, compose them into one Worker, and deploy to a user's account.
[Anglesite](https://anglesite.app) is the first consumer; each package must
stand alone for any third-party developer.

## 2. Goals

- Ship each protocol capability as an independently usable, semver'd `@dwk` npm
  package.
- Every package deploys to a **user-owned Cloudflare account** — no central
  server holds data or keys.
- Packages **compose** into a single Worker behind one domain (the user's
  IndieWeb / WebID identity root).
- Provide a Workers-native edge implementation of the Solid data plane (no
  long-running Node server).
- Pass the relevant conformance suites (see
  [conformance-and-testing.md](conformance-and-testing.md)).
- TypeScript-first: the type definitions are the integration contract.

## 3. Non-goals (v1)

- A hosted / managed offering or multi-tenant central service.
- A full Solid-OIDC **Identity Provider** — v1 implements the Resource Server
  only and delegates issuance (see [open-questions.md](open-questions.md)).
- A SPARQL **query** endpoint — Solid requires only PATCH semantics.
- Sharding a single pod across Durable Objects (see
  [open-questions.md](open-questions.md)).
- **Runtimes other than Cloudflare Workers.** Cloudflare is the sole deployment
  target; packages MAY freely assume Workers, Durable Objects, R2, D1, and KV
  primitives.
- The provisioning UI / `wrangler` config generation — that lives in Anglesite,
  not these packages.

## 4. Audience & usage model

Two consumers, one contract:

1. **Provisioning apps (Anglesite).** A local app that holds the user's scoped
   Cloudflare API token, composes the packages into a Worker, binds storage,
   and deploys. The packages expose everything it needs declaratively (required
   bindings, config schema).
2. **Third-party developers.** `npm install` one or more `@dwk` packages, mount
   the handlers in their own Worker, wire bindings in `wrangler.toml`, deploy.

Identity is rooted at the user's domain: the same domain serves the IndieWeb
identity (IndieAuth) and the WebID the Pod authenticates against. This shared
root is what lets the IndieWeb trio and the Solid Pod present as one coherent
self-owned presence.
