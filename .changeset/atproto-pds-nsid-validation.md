---
"@dwk/atproto-pds": patch
---

Tighten NSID validation (`isValidNsid`) to match the AT Protocol NSID syntax.

The previous regex accepted any string of two-or-more dot-separated segments and
applied the authority charset to every segment, so it wrongly accepted
two-segment names (e.g. `app.bsky`) and hyphens in the trailing name segment
(e.g. `com.example.foo-bar`). `isValidNsid` now requires:

- at least **three** segments — the authority (every segment but the last) must
  itself be ≥2 segments, plus the trailing name segment;
- every segment to start with an ASCII letter, be 1–63 chars of letters, digits
  and hyphens, and not end with a hyphen;
- the final **name** segment to be letters and digits only (no hyphens);
- the whole NSID to be ≤317 chars.
