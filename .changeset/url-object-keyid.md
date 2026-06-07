---
"@dwk/activitypub": patch
---

Parse the HTTP Signature `keyId` with the WHATWG `URL` object instead of
splitting on `#`. The default key resolver now strips the IRI fragment per the
URL spec and rejects an unparseable `keyId` before issuing a network fetch,
rather than reproducing fragment-stripping with string surgery. It also
restricts the `keyId` to `http(s)` schemes, so a crafted `data:`/`file:` IRI
cannot smuggle an attacker-chosen key past signature verification on runtimes
whose `fetch` dereferences such URIs.
