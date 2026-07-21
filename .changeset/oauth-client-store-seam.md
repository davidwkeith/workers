---
"@dwk/oauth": minor
---

Add the `ClientStore` seam — `getClient(clientId)` alongside `saveClient` — so
consumers building authorize/token grants over the RFC 7591 registration
handler can verify redirect URIs and client secrets through one interface.
