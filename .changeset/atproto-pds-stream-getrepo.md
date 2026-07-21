---
"@dwk/atproto-pds": patch
---

Stream the full-repository CAR export (`getRepo`) instead of buffering the
whole repository into Durable Object memory. The MST is now built from a
lightweight key/CID-only query so building it doesn't decode every record body
either, closing a violation of the 128 MB DO memory budget on large accounts.
