---
"@dwk/micropub": minor
---

Bind authorization to the site owner. `MicropubConfig` now requires `me` (the
owner's IndieAuth profile URL), and `authorize` rejects any access token whose
subject (`sub`, the canonical `me`) does not match it. Previously a token minted
by the same issuer for _any_ `me` carrying the right scope could create, update,
or delete posts on the site — an authorization bypass in multi-user or
shared-issuer deployments. The `me` is canonicalized at config-resolution time
and compared exactly against the token's already-canonical subject.
