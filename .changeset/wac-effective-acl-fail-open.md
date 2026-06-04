---
"@dwk/wac": patch
---

Fix a fail-open hazard in the effective-ACL walk and harden agent/origin
matching. `evaluateAccess` previously skipped any ACL document whose
authorizations did not apply to the target, so a resource's own `.acl` that
existed but granted nothing for the request fell through to a permissive
ancestor `acl:default`. `AclResource` now carries a `present` flag: a present
ACL document is authoritative and stops the walk (granted or denied) without
climbing, so an own ACL cannot inherit an ancestor default. Additionally, an
empty-string `agent` is no longer treated as authenticated (it can no longer
satisfy `acl:AuthenticatedAgent` or match an empty `acl:agent`), and `acl:origin`
comparisons normalize both sides via `URL` so case and trailing-slash
differences do not defeat a correctly-configured allow-list.
