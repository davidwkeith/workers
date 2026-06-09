# @dwk/wac

Web Access Control evaluation — a Solid-specific helper library.

## What this is

Evaluates ACL authorization for Solid resources. Implements effective-ACL walking
with `acl:default` inheritance, access-mode evaluation (Read, Write, Append,
Control), group membership, `acl:agentClass foaf:Agent` (public access),
`acl:origin` checks, and the Append-vs-Write distinction (Append = insert-only;
Write = any mutation including delete).

## Spec

`spec/packages/wac.md` — authoritative requirements.

## Key constraints

- **Solid-specific by design.** Unlike the cross-standard libs, this is
  intentionally tied to the Solid WAC model.
- **No Cloudflare imports.** Pure-data library. Takes `AclQuad[]` arrays (plain
  objects), not N3 store instances.
- **No caching.** ACL decisions are never cached outside the strongly-consistent
  store layer. The caller (`solid-pod` DO) evaluates fresh on every request.
- **Append ≠ Write.** Append grants insert-only access; deleting triples
  requires Write. This distinction is load-bearing for Solid compliance.

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/wac
```

## File layout

```
src/index.ts       # public surface: evaluateAccess, AclQuad, AccessMode, AccessRequest, AccessDecision
src/*.test.ts      # colocated tests
```

## Dependencies

- `@dwk/rdf` — quad types.

## Depended on by

`@dwk/solid-pod`
