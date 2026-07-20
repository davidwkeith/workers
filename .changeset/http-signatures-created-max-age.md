---
"@dwk/http-signatures": patch
---

Bound the age of a signature's `created` timestamp so a captured proof without
an `expires` cannot be replayed indefinitely (#294). Verification previously
checked only the future direction of `created` (`created > now + tolerance`);
there was no lower bound, so a signature that carried `created` but no `expires`
(common for draft-cavage) stayed valid forever. Both the RFC 9421 and cavage
verifiers now reject a `created` older than `now - maxAgeSeconds` (allowing
`toleranceSeconds` of skew) with the new `created_stale` reason. `maxAgeSeconds`
defaults to 3600 (one hour) and is configurable; pass `Infinity` to disable. The
bound applies only when `created` is present.
