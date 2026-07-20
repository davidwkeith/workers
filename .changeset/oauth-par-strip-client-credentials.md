---
"@dwk/oauth": patch
---

Never persist client-authentication credentials into the stored PAR record
(#295). The Pushed Authorization Request handler copied every form field into
the saved `PushedRequestRecord.params`, so a client authenticating with
`client_secret_post` (or `private_key_jwt`) had its `client_secret` /
`client_assertion` written into the request store at rest. The handler now
strips `client_secret`, `client_assertion`, and `client_assertion_type` before
saving, keeping only the authorization parameters (RFC 9126).
