# `@dwk/wac`

| | |
|---|---|
| **Type** | lib (standard-specific helper) |
| **Ships a DO?** | no |
| **Used by** | [`@dwk/solid-pod`](solid-pod.md) |

Web Access Control evaluation. A **standard-specific helper** (tied to Solid /
WAC by design), as distinct from the cross-standard reusables
[`@dwk/rdf`](rdf.md) and [`@dwk/dpop`](dpop.md).

## Functional requirements

- **Effective-ACL walk:** resolve the nearest applicable `.acl`, honoring
  `acl:default` on an ancestor container.
- Evaluate the access modes `acl:Read`, `acl:Write`, `acl:Append`,
  `acl:Control`.
- Support **groups**, `acl:agentClass foaf:Agent`, and `acl:origin`.
- Enforce the **Append vs Write** distinction:
  - `Append` authorizes **insert-only** patches.
  - **Any delete requires `Write`.**

## Design constraints

- **Plain-data inputs only.** The package MUST take ACL graphs and request facts
  as plain data and return a decision, so it **unit-tests without a Workers
  runtime** (see
  [composition-contract.md](../composition-contract.md#confinement-of-cloudflare-specifics)).
- **No decision caching** outside strongly-consistent layers — callers MUST NOT
  memoize decisions in KV or other eventually-consistent stores (see
  [non-functional-requirements.md](../non-functional-requirements.md#security)).

## Testing

- Pure unit tests over crafted ACL graphs covering each mode, default
  inheritance, group/agentClass/origin matching, and the Append-vs-Write
  boundary.
