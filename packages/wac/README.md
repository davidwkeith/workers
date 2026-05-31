# `@dwk/wac`

Web Access Control (WAC) evaluation for Solid Pods. A pure, dependency-light
library consumed by [`@dwk/solid-pod`](../solid-pod): it takes ACL graphs (as
plain quads, compatible with [`@dwk/rdf`](../rdf) terms) plus request facts and
returns an authorization decision. No Cloudflare bindings; unit-testable without
a Workers runtime.

See the [spec](../../spec/packages/wac.md) for the authoritative requirements,
and the [Solid WAC specification](https://solidproject.org/TR/wac) for the model.

## What it does

- **Effective-ACL walk** — resolves the nearest applicable `.acl`, honoring
  `acl:default` on ancestor containers. A resource's own `acl:accessTo` ACL
  takes precedence over inherited `acl:default` ACLs.
- **Modes** — `acl:Read`, `acl:Write`, `acl:Append`, `acl:Control`.
- **Subjects** — `acl:agent`, `acl:agentGroup`, and `acl:agentClass`
  (including `foaf:Agent` for public access and `acl:AuthenticatedAgent`).
- **Origin** — `acl:origin` acts as a per-authorization allow-list.
- **Append vs Write** — an `append` request is satisfied by `acl:Append` _or_
  `acl:Write`; a delete must be requested as `write`, which `acl:Append` alone
  never grants.

> Decisions MUST NOT be memoized in eventually-consistent stores (e.g. KV); the
> walk is cheap and is meant to run against strongly-consistent ACL state.

## Usage

```ts
import { evaluateAccess, type AclResource } from "@dwk/wac";

// Build the effective-ACL chain, nearest first. The requested resource's own
// ACL uses scope "accessTo"; ancestor container ACLs use scope "default".
const chain: AclResource[] = [
  { target: "https://alice.example/notes/secret.ttl", scope: "accessTo", quads: resourceAclQuads },
  { target: "https://alice.example/notes/", scope: "default", quads: containerAclQuads },
];

const decision = evaluateAccess(
  { mode: "write", agent: "https://bob.example/card#me", origin: "https://app.example" },
  chain,
);

if (!decision.granted) {
  // 401 if unauthenticated, otherwise 403.
}
```
