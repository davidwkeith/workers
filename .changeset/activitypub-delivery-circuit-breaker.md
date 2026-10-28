---
"@dwk/activitypub": minor
---

Add a per-host delivery circuit breaker. After 5 consecutive retryable failures to a host, its deliveries are deferred, without spending retry attempts, for a cooldown that starts at 10 minutes and doubles on each failed probe up to 24 hours. A success or a signed inbound activity from the host closes the circuit, and a host failing for 7 days has its deliveries dropped while the circuit is open. New log/metric events: `activitypub.delivery.deferred`, `activitypub.delivery.circuit_opened`, `activitypub.delivery.circuit_closed`.
