---
"@dwk/server": patch
---

Added a baseline security-header layer (`helmet`, with CSP left off since
`publicDir` can serve an arbitrary self-hosted site) applied to every
response, and an explicit `dotfiles: "deny"` policy on `express.static` so a
dotfile (`.env`, `.git/…`) under `publicDir` is never served regardless of a
composition's fallback route. `crossOriginResourcePolicy` is relaxed from
helmet's `same-origin` default to `cross-origin`, since this host composes
`@dwk` protocols (WebFinger, ActivityPub, IndieAuth) whose discovery documents
are explicitly meant to be fetched cross-origin by a browser.
