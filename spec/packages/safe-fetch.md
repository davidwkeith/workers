# `@dwk/safe-fetch`

|                  |                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Type**         | lib (cross-standard reusable)                                                                                                                                                                                |
| **Ships a DO?**  | no                                                                                                                                                                                                           |
| **Used by**      | every package that fetches an attacker- or user-supplied URL: [`@dwk/webmention`](webmention.md), [`@dwk/websub`](websub.md), [`@dwk/microsub`](microsub.md), [`@dwk/vc`](vc.md), [`@dwk/atproto-pds`](atproto-pds.md), `@dwk/esi` |

The single shared choke point for outbound fetches of untrusted URLs — a
Webmention `source`, a WebSub `hub.callback`, a Microsub feed URL, a
credential's `statusListCredential`, a `did:web` host, an ESI fragment `src`.
A **cross-standard reusable**: no IndieWeb/Solid assumptions, no Workers
runtime dependency (plain-data inputs, injectable `fetch`).

## Functional requirements

- **`assertPublicUrl(rawUrl, options)`** — validate that a URL is fetchable:
  parseable, an allowed scheme (default `http:`/`https:`), and not a
  private/reserved host. Host validation is purely syntactic (the Workers
  runtime exposes no DNS), covering loopback, RFC 1918, link-local (incl. the
  cloud metadata IP), CGNAT, benchmark/TEST-NET, multicast/reserved,
  IPv6 equivalents (incl. IPv4-embedded forms), `localhost`/`.localhost`,
  `.local`, `.internal`, and the RFC 7686 `.onion` TLD.
- **`safeFetch(doFetch, rawUrl, init, options)`** — fetch with guardrails:
  the initial host and **every redirect hop** re-validated via
  `assertPublicUrl`; manual redirects capped at `maxRedirects` (default 5); a
  single overall timeout (default 10 s) combined with any caller signal;
  credential headers (plus `stripHeadersCrossOrigin` extras) stripped on
  cross-origin hops; method/body preserved across hops.
- **`safeFetchJson`** — `safeFetch` plus a capped, content-type-checked JSON
  body read.
- **`readBodyCapped` / `readBytesCapped`** — body readers that refuse to
  buffer past a byte cap, ignoring a lying `Content-Length`.
- **Observability:** an SSRF block MUST be logged/counted under the
  caller-supplied `logEvent` (default `safe_fetch.ssrf.blocked`) through the
  injected [`@dwk/log`](log.md) seams; a blocked attempt then surfaces to the
  caller exactly like a network failure (`SsrfError`, with a structured
  `reason` and sanitized `host`).

## Local-development allowlist (`allowedHosts`, issue #257)

Composing apps that run the Worker locally (Anglesite's `wrangler dev --local`
runtime, [Anglesite-app#708](https://github.com/Anglesite/Anglesite-app/issues/708))
need the workers to fetch the dev site they sit next to — `http://localhost:<port>` —
which the host block correctly refuses in production. `allowedHosts` is the
explicit, composer-injected escape hatch:

- `AssertPublicUrlOptions.allowedHosts?: readonly string[]` — **exact**
  `host[:port]` entries (case-insensitive; bracketed IPv6 like `[::1]:4321`)
  exempted from the private/reserved-host block only. No wildcards, no CIDR
  ranges, no suffix matching.
- Everything else still applies to an allowlisted host: scheme checks,
  redirect caps and per-hop re-validation (against the same list), timeouts,
  and body caps.
- **Deny-by-default is unchanged.** The list MUST reach the lib only through a
  package's factory config (the consuming packages expose it as
  `fetchAllowedHosts`); it MUST NOT be read from the environment or any
  global, so a production composition cannot inherit it accidentally.
- **Audit trail:** whenever a fetch reaches a host that passed only because it
  was allowlisted, `safeFetch` logs and counts `safe_fetch.ssrf.allowed_host`
  (exported as `ALLOWED_HOST_EVENT`) with the sanitized host — so an
  allowlist that leaks into production stays visible in logs.

## Non-requirements

- DNS-rebinding defense (no name resolution is exposed to Worker code).
- Proxying or caching; this is a validation wrapper, not a transport.
