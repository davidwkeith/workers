---
"@dwk/indieauth": minor
---

Add an opt-in token introspection endpoint (RFC 7662; IndieAuth §6.1), so resource servers on other hosts can verify tokens. Set `authorizeIntrospection(request)` to serve it (default `/introspect`, override with `introspectionEndpoint`) and advertise `introspection_endpoint`; IndieAuth requires the endpoint to demand authorization, so without the hook it is neither served nor advertised. An active token returns `me`, `client_id`, `scope`, `exp`, `iat`, `token_type`, `aud` when restricted, and `cnf.jkt` when DPoP-bound; anything else is `{"active": false}`. The metadata now also sets `authorization_response_iss_parameter_supported: true`, since the authorization response already carries `iss`.
