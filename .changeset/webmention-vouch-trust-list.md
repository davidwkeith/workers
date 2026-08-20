---
"@dwk/webmention": patch
---

Fix Vouch verification (indieweb.org/Vouch), shipped in the prior `minor` release with two
bugs: it matched the vouch page against the **target's** domain instead of the **source's**,
and had no trust list at all — meaning `vouch=<the source URL itself>` verified unconditionally
once `verifySource` had already proven that link exists. `verifyVouch` now takes a required
`isTrustedDomain` predicate, checked before any fetch (an untrusted vouch domain returns
`verified: false` with no network access at all, closing a fetch-amplification side issue too),
and matches the fetched page against the source's hostname. `WebmentionConfig` gains an
optional `isTrustedVouchDomain`; omitted, every vouch verifies false rather than defaulting to
trusted. `VouchVerified` now logs on every exit path (`reason` field), not only the one that
reaches the link check. Part of Anglesite/Anglesite#1597.
