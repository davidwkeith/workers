---
"@dwk/deno-host": minor
---

`createS3Bucket({ client, endpoint })`: a thin `R2Bucket`-shaped adapter over
an external S3-compatible provider (issue #400, host-contract §3.4) —
`put`/`get`/`head`/`delete` map onto the S3 REST verbs
`PUT`/`GET`/`HEAD`/`DELETE`. `httpMetadata.contentType` round-trips as the
`Content-Type` header; `customMetadata` round-trips as `x-amz-meta-*`
headers (lowercased on read-back, a documented divergence from R2's
case-preserving behavior). A `ReadableStream` `put` value streams through a
byte-counting `TransformStream` rather than buffering, so the returned
`R2Object.size` is known without reading the whole body into memory first.
The injected `S3ClientLike` seam is a single `fetch`-shaped method already
configured to sign requests for the target endpoint — most naturally
`aws4fetch`'s `AwsClient#fetch` — keeping the package dependency-free rather
than typing against the AWS SDK's `S3Client.send(Command)` surface. This is
the last of the four gaps `@dwk/deno-host` set out to close (#397, #398,
#399 landed previously); all four now override the demand gate in
`deno-deploy-design.md` §6 for this package's shims specifically, while an
actual deployed Deno Deploy app (Phase 1) stays a separate, still-gated
decision.
