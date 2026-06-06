import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { JsonObject } from "./data-integrity";
import {
  buildEncodedList,
  buildStatusEntry,
  buildStatusListCredential,
  createVcStatusStore,
  decodeBitstring,
  encodeBitstring,
  findStatusEntry,
  getBit,
  setBit,
  statusEntryIndex,
  type VcStatusStoreEnv,
} from "./status-list";

const storeEnv = env as unknown as VcStatusStoreEnv;

describe("bitstring bit operations", () => {
  it("is most-significant-bit-first within a byte", () => {
    const bits = new Uint8Array(1);
    setBit(bits, 0, true);
    expect(bits[0]).toBe(0b1000_0000);
    setBit(bits, 7, true);
    expect(bits[0]).toBe(0b1000_0001);
    expect(getBit(bits, 0)).toBe(true);
    expect(getBit(bits, 7)).toBe(true);
    expect(getBit(bits, 3)).toBe(false);
  });

  it("clears a bit and reports out-of-range reads as false", () => {
    const bits = new Uint8Array(1);
    setBit(bits, 2, true);
    setBit(bits, 2, false);
    expect(getBit(bits, 2)).toBe(false);
    expect(getBit(bits, 99)).toBe(false);
  });

  it("throws when setting an out-of-range bit", () => {
    expect(() => setBit(new Uint8Array(1), 99, true)).toThrow(/out of range/);
  });

  it("rejects negative indices", () => {
    expect(getBit(new Uint8Array(1), -1)).toBe(false);
    expect(() => setBit(new Uint8Array(1), -1, true)).toThrow(/out of range/);
  });
});

describe("encodeBitstring / buildEncodedList", () => {
  it("round-trips through gzip + multibase base64url", async () => {
    const bits = new Uint8Array(16);
    setBit(bits, 5, true);
    setBit(bits, 100, false);
    const encoded = await encodeBitstring(bits);
    expect(encoded[0]).toBe("u");
    const decoded = await decodeBitstring(encoded);
    expect(getBit(decoded, 5)).toBe(true);
  });

  it("builds an encoded list with the given indices set", async () => {
    const encoded = await buildEncodedList([1, 42, 1000], 2048);
    const bits = await decodeBitstring(encoded);
    expect(getBit(bits, 1)).toBe(true);
    expect(getBit(bits, 42)).toBe(true);
    expect(getBit(bits, 1000)).toBe(true);
    expect(getBit(bits, 2)).toBe(false);
  });
});

describe("status credential and entry builders", () => {
  it("builds a BitstringStatusListCredential", () => {
    const cred = buildStatusListCredential({
      id: "https://example.com/status/revocation",
      statusPurpose: "revocation",
      encodedList: "uH4sIAAAA",
      issuer: "did:web:example.com",
    });
    expect(cred.type).toEqual([
      "VerifiableCredential",
      "BitstringStatusListCredential",
    ]);
    const subject = cred.credentialSubject as JsonObject;
    expect(subject.type).toBe("BitstringStatusList");
    expect(subject.statusPurpose).toBe("revocation");
  });

  it("emits validUntil and ttl on the credential and subject", () => {
    const cred = buildStatusListCredential({
      id: "https://example.com/status/revocation",
      statusPurpose: "revocation",
      encodedList: "uH4sIAAAA",
      issuer: "did:web:example.com",
      validUntil: "2030-01-01T00:00:00Z",
      ttl: 300000,
    });
    expect(cred.validUntil).toBe("2030-01-01T00:00:00Z");
    expect(cred.ttl).toBe(300000);
    expect((cred.credentialSubject as JsonObject).ttl).toBe(300000);
  });

  it("supports one-or-more status purposes", () => {
    const cred = buildStatusListCredential({
      id: "https://example.com/status/combo",
      statusPurpose: ["revocation", "suspension"],
      encodedList: "uH4sIAAAA",
      issuer: "did:web:example.com",
    });
    expect((cred.credentialSubject as JsonObject).statusPurpose).toEqual([
      "revocation",
      "suspension",
    ]);

    const entry = buildStatusEntry({
      statusListCredential: "https://example.com/status/combo",
      statusListIndex: 7,
      statusPurpose: ["revocation", "suspension"],
    });
    const credential: JsonObject = { credentialStatus: entry };
    expect(findStatusEntry(credential, "revocation")).toEqual(entry);
    expect(findStatusEntry(credential, "suspension")).toEqual(entry);
    expect(findStatusEntry(credential, "other")).toBeUndefined();
  });

  it("builds and reads a status entry", () => {
    const entry = buildStatusEntry({
      statusListCredential: "https://example.com/status/revocation",
      statusListIndex: 94567,
      statusPurpose: "revocation",
    });
    expect(entry.type).toBe("BitstringStatusListEntry");
    expect(entry.statusListIndex).toBe("94567");
    expect(statusEntryIndex(entry)).toBe(94567);

    const credential: JsonObject = { credentialStatus: entry };
    expect(findStatusEntry(credential, "revocation")).toEqual(entry);
    expect(findStatusEntry(credential, "suspension")).toBeUndefined();
  });
});

describe("createVcStatusStore (D1)", () => {
  it("fails loudly without the binding", () => {
    expect(() => createVcStatusStore({} as VcStatusStoreEnv)).toThrow(
      /VC_STATUS_DB/,
    );
  });

  it("allocates monotonic indices and round-trips status bits", async () => {
    const store = createVcStatusStore(storeEnv);
    await store.init();
    const list = `urn:list:${crypto.randomUUID()}`;

    const a = await store.allocateIndex(list, "revocation");
    const b = await store.allocateIndex(list, "revocation");
    expect(b).toBe(a + 1);

    expect(await store.getStatus(list, "revocation", a)).toBe(false);
    await store.setStatus(list, "revocation", a, true);
    expect(await store.getStatus(list, "revocation", a)).toBe(true);

    await store.setStatus(list, "revocation", 7, true);
    expect(await store.setIndices(list, "revocation")).toEqual(
      [a, 7].sort((x, y) => x - y),
    );

    // Purposes are independent.
    expect(await store.getStatus(list, "suspension", a)).toBe(false);
  });

  it("clears a bit by deleting its row (no tombstone)", async () => {
    const store = createVcStatusStore(storeEnv);
    await store.init();
    const list = `urn:list:${crypto.randomUUID()}`;

    await store.setStatus(list, "suspension", 3, true);
    expect(await store.setIndices(list, "suspension")).toEqual([3]);

    await store.setStatus(list, "suspension", 3, false);
    expect(await store.getStatus(list, "suspension", 3)).toBe(false);
    expect(await store.setIndices(list, "suspension")).toEqual([]);
  });
});
