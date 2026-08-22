---
"@dwk/wac": minor
---

Implement Web Access Control evaluation with `evaluateAccess`: effective-ACL walk honoring `acl:default` inheritance with `accessTo` precedence, `acl:Read`/`Write`/`Append`/`Control` modes, `acl:agent`/`agentGroup`/`agentClass` (incl. `foaf:Agent` and `acl:AuthenticatedAgent`), `acl:origin` allow-lists, and the Append-vs-Write boundary.
