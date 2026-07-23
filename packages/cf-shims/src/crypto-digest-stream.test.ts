import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { installCryptoDigestStream } from "./crypto-digest-stream.js";

function toHex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("hex");
}

describe("installCryptoDigestStream", () => {
  it("hashes a piped stream and matches node:crypto's digest, and is idempotent", async () => {
    installCryptoDigestStream();
    installCryptoDigestStream(); // second call early-returns (already installed)

    const bytes = new TextEncoder().encode("hello digest stream");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 5));
        controller.enqueue(bytes.slice(5));
        controller.close();
      },
    });

    const DigestStream = (crypto as unknown as { DigestStream: unknown })
      .DigestStream as new (algorithm: string) => WritableStream<Uint8Array> & {
      digest: Promise<ArrayBuffer>;
    };
    const digestStream = new DigestStream("SHA-256");
    await source.pipeTo(digestStream);

    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(toHex(await digestStream.digest)).toBe(expected);
  });

  it("supports every documented algorithm and rejects an unsupported one", async () => {
    installCryptoDigestStream();
    const DigestStream = (crypto as unknown as { DigestStream: unknown })
      .DigestStream as new (algorithm: string) => WritableStream<Uint8Array> & {
      digest: Promise<ArrayBuffer>;
    };

    for (const [algorithm, nodeName] of [
      ["MD5", "md5"],
      ["SHA-1", "sha1"],
      ["SHA-256", "sha256"],
      ["SHA-384", "sha384"],
      ["SHA-512", "sha512"],
    ] as const) {
      const digestStream = new DigestStream(algorithm);
      const writer = digestStream.getWriter();
      await writer.write(new TextEncoder().encode("x"));
      await writer.close();
      const expected = createHash(nodeName).update("x").digest("hex");
      expect(toHex(await digestStream.digest)).toBe(expected);
    }

    expect(() => new DigestStream("SHA-3")).toThrow(/unsupported algorithm/);
  });

  it("rejects the digest when the stream aborts", async () => {
    installCryptoDigestStream();
    const DigestStream = (crypto as unknown as { DigestStream: unknown })
      .DigestStream as new (algorithm: string) => WritableStream<Uint8Array> & {
      digest: Promise<ArrayBuffer>;
    };
    const digestStream = new DigestStream("SHA-256");
    const writer = digestStream.getWriter();
    await writer.abort(new Error("boom"));
    await expect(digestStream.digest).rejects.toThrow("boom");
  });
});
