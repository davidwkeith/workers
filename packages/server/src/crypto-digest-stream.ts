/**
 * Install a Node `crypto.DigestStream` global.
 *
 * `@dwk/store`'s streamed blob write path (`stageAndHash`, used by
 * `putBlob` for a `ReadableStream`/`Blob` body — e.g. a declared-length PUT
 * over the inline ceiling, or a WebDAV `COPY`/`MOVE` re-streaming an
 * existing blob to a new key) hashes the body by piping it through
 * `crypto.DigestStream`, Cloudflare's non-standard `WritableStream` subclass
 * that retains no data and exposes the running digest as `.digest`. It is
 * the one non-WHATWG Web API `@dwk/store` depends on
 * (spec/portability.md §2.2) and is trivially polyfillable on `node:crypto`'s
 * incremental `Hash`, so the host installs one when none exists — idempotent,
 * and a no-op where a native `DigestStream` already exists (workerd, or a
 * deployer-installed one).
 *
 * @see spec/self-hosting.md §7.5
 */

import { createHash } from "node:crypto";

/** Algorithm names `crypto.DigestStream` accepts, mapped to `node:crypto`'s. */
const ALGORITHMS: Record<string, string> = {
  MD5: "md5",
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

/** A `WritableStream` that hashes the bytes written to it without retaining them. */
class DigestStream extends WritableStream<BufferSource> {
  /** Resolves to the digest once the stream closes. */
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string | { name: string }) {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    const nodeAlgorithm = ALGORITHMS[name.toUpperCase()];
    if (!nodeAlgorithm) {
      throw new TypeError(`DigestStream: unsupported algorithm "${name}"`);
    }
    const hash = createHash(nodeAlgorithm);
    let resolveDigest: (value: ArrayBuffer) => void;
    let rejectDigest: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        hash.update(
          chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk,
        );
      },
      close() {
        const digested = hash.digest();
        resolveDigest(
          digested.buffer.slice(
            digested.byteOffset,
            digested.byteOffset + digested.byteLength,
          ) as ArrayBuffer,
        );
      },
      abort(reason) {
        rejectDigest(reason);
      },
    });
    this.digest = digest;
  }
}

/** Install `crypto.DigestStream` as a global if one is not already present. */
export function installCryptoDigestStream(): void {
  const c = crypto as unknown as { DigestStream?: unknown };
  c.DigestStream ??= DigestStream;
}
