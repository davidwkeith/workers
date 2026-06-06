---
"@dwk/wac": patch
---

Fix the effective-ACL stop condition to match WAC §5.1. `evaluateAccess`
previously climbed past an existing-but-non-matching ancestor `acl:default`
document (unless it was flagged `present`), which inverts the spec: §5.1 selects
the _first_ ancestor whose ACL resource exists as the effective ACL "regardless
of whether it contains matching authorizations", and that one document then
makes a fail-closed decision. The chain already lists only existing ACL
documents nearest-first, so its first entry is now treated as the authoritative
effective ACL — granted or denied — and the content-based climb is removed. This
was not reachable through `@dwk/solid-pod` (which resolves and passes the single
effective ACL itself), but was a correctness trap for any other caller. The
now-redundant `AclResource.present` flag is removed.
