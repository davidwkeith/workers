---
"@dwk/deno-host": minor
---

`createDurableObjectNamespace` gains an opt-in
`DurableObjectNamespaceOptions.onLeaseAcquired?(idHex, client)` hook (issue
#432, host-contract §8's growth discipline): called once per dispatch — a
`fetch()` or an about-to-run `alarm()` (skipped for a superseded/no-op claim)
— after the id's per-request lease is acquired and before the event runs,
passed the same `SyncSqliteDatabaseLike` instance `getStorageClient(idHex)`
returned for that id. This is the injection point a host needs for the
sync-before-serve rule (spec/scale-out.md §6.2): a different replica may have
written to an object id's database since this instance last held the lease,
and the embedded-replica client must sync from its primary before the event
sees it. This package still takes no dependency on any richer client
capability — `client`'s static type stays the plain `SyncSqliteDatabaseLike`
seam, and it is the host's job to narrow it to whatever concrete type its own
`getStorageClient` constructs and call that type's sync method there.
Omitting the option (every existing caller) is unchanged behavior. On the
alarm path, a rejecting hook does not consume a retry attempt — it's treated
like a lease-acquisition failure (re-posted at `now` with the same
`retryCount`), since the handler never got a chance to run.
