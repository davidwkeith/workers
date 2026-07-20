---
"@dwk/micropub": patch
"@dwk/atproto-pds": patch
---

Stop a client-controlled `Content-Type` on a served blob from becoming stored
XSS (#299). Both packages serve public, unauthenticated blobs whose content type
comes from the (client-controlled) upload, so an uploaded `text/html` (or
`image/svg+xml`) would render as active content on the deployment's own origin —
`@dwk/micropub`'s `media`-scope-only endpoint could thereby escalate to
origin-level script execution. The serve paths now always send
`X-Content-Type-Options: nosniff`, and only serve a known safe media type
(image/video/audio) inline; anything else is served as an opaque
`application/octet-stream` with `Content-Disposition: attachment`, so it
downloads instead of executing. (Note that `nosniff` alone would not stop an
explicit `text/html`, hence the inline allow-list.)
