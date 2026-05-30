# @dwk/dpop

## 0.1.0

### Initial release

- `verifyDpopProof` — verify a DPoP proof JWT per RFC 9449 §4.3: JOSE header
  (`typ` is `dpop+jwt`, asymmetric `alg` allow-list, public-only `jwk`),
  signature over the embedded key, and the `htm` / `htu` / `iat` / `jti` claims.
- Computes the RFC 7638 JWK thumbprint and exposes it as `jkt`.
- Resource Server bindings: optional `ath` (access-token hash) and `cnf.jkt`
  (`expectedJkt`) checks.
- Surfaces the verified `jti` so callers can enforce their own replay policy.
