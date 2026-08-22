---
"@dwk/server": minor
---

Add full `.env` support: `loadDwkEnv()` loads `<domain>.env` (the hostname of
`DWK_BASE_URL`) and/or `.env` from the working directory, with real
environment variables always winning over either file and a domain-specific
file winning over the generic one. `dwk-serve`'s CLI calls it automatically;
the bundled Docker entry and reference compositions call it explicitly.

Parsing and `encrypted:`-value decryption are provided by a new pinned
dependency, `@dotenvx/dotenvx` — no custom cryptography. `.env.example` is
expanded into the full reference (every supported variable, the file
precedence rules, and the encrypt/decrypt workflow via
`npx @dotenvx/dotenvx encrypt`), and the root `.gitignore` now covers any
`<domain>.env` file and dotenvx's `.env.keys` private-key store.
