---
"@dwk/solid-pod": minor
---

Add the **owner-gated WebDAV app-password endpoint**
(`createSolidPodWebdavCredentials`) so users can mint, list, and revoke the
Basic-auth credentials the WebDAV door consumes (#169) — instead of seeding them
out of band.

Issuance is a resource-server concern guarded by the pod's existing DPoP-bound
**owner** token (distinct from the Basic-auth data door): the Solid front door
authenticates at the edge, then the per-pod `SolidPodObject` re-checks ownership
and serves `POST` (mint — the plaintext secret is returned exactly once), `GET`
(list the owner's credentials, metadata only — never the hash or secret), and
`DELETE ?id=…` (revoke; an owner may only revoke a credential bound to their own
WebID). Credentials bind to the authenticated owner's WebID and verify on the
same per-pod `CredentialStore` the data door reads.
