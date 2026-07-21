import { describe, expect, it } from "vitest";

import type { ClientRecord, ClientStore } from "./store.js";

/** In-memory reference implementation, as a consumer would write for tests. */
function memoryClientStore(): ClientStore {
  const clients = new Map<string, ClientRecord>();
  return {
    async saveClient(record) {
      clients.set(record.clientId, record);
    },
    async getClient(clientId) {
      return clients.get(clientId) ?? null;
    },
  };
}

describe("ClientStore", () => {
  it("round-trips a saved client and misses unknown ids", async () => {
    const store = memoryClientStore();
    const record: ClientRecord = {
      clientId: "abc",
      clientIdIssuedAt: 1_700_000_000,
      clientSecret: "hashed-secret",
      metadata: { client_name: "Test", redirect_uris: ["https://a/cb"] },
    };
    await store.saveClient(record);
    expect(await store.getClient("abc")).toEqual(record);
    expect(await store.getClient("missing")).toBeNull();
  });
});
