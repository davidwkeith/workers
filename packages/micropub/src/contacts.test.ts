import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  canonicalContactUrl,
  contactWrite,
  createMicropubContactStore,
  type MicropubContactStoreEnv,
} from "./contacts.js";

const harness = env as unknown as MicropubContactStoreEnv;

describe("Micropub contact store", () => {
  it("canonicalizes, searches nested unknown properties, and orders deterministically", async () => {
    expect(canonicalContactUrl({ url: ["HTTPS://EXAMPLE.COM:443"] })).toBe(
      "https://example.com/",
    );
    const store = createMicropubContactStore(harness);
    const suffix = crypto.randomUUID();
    const beta = contactWrite(
      `beta-${suffix}`,
      { name: ["Beta"], note: [{ value: "Needle" }] },
      1,
    );
    const alpha = contactWrite(`alpha-${suffix}`, { name: ["Alpha"] }, 1);
    expect(await store.create(beta)).toBe("created");
    expect(await store.create(alpha)).toBe("created");
    expect(
      (await store.list({ filter: "needle", limit: 10, offset: 0 })).map(
        (contact) => contact.id,
      ),
    ).toEqual([beta.id]);
    const ours = (await store.list({ limit: 10, offset: 0 })).filter(
      (contact) => contact.id.endsWith(suffix),
    );
    expect(ours.map((contact) => contact.id)).toEqual([alpha.id, beta.id]);
  });
});
