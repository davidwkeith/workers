---
"@dwk/solid-pod": patch
---

Fix a privilege escalation where a container `POST` with a `Slug` ending in a
reserved auxiliary suffix (`.acl`/`.meta`) could mint that auxiliary resource.
A `POST` is only authorized for `Append`/`Write` on the parent container, but
the sanitized `Slug` preserved `.`, so `Slug: evil.acl` produced the ACL
document `/c/evil.acl` — letting an `Append`-only agent write an ACL that WAC
reserves for `acl:Control`. `childKey` now treats a `Slug` that would yield a
reserved auxiliary key as unusable and falls back to a random name, so a
container `POST` can never create an `.acl`/`.meta`. Adds the
`hasReservedAuxiliarySuffix` helper.
