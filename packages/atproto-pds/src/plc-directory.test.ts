import { describe, expect, it, vi } from "vitest";

import {
  fetchPlcData,
  resolvePlcDid,
  submitPlcOperation,
  type FetchLike,
} from "./plc-directory.js";
import type { SignedPlcOperation } from "./plc.js";

const DID = "did:plc:abc234abc234abc234abc234";

const OP: SignedPlcOperation = {
  type: "plc_operation",
  rotationKeys: ["did:key:zQ3shrot"],
  verificationMethods: { atproto: "did:key:zDnsig" },
  alsoKnownAs: ["at://alice.example.com"],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint: "https://alice.example.com",
    },
  },
  prev: null,
  sig: "c2ln",
};

/** A fake fetch that records the call and returns a scripted response. */
function fakeFetch(responder: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

describe("PLC directory client", () => {
  it("POSTs a signed operation to /:did with a JSON body", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(null, { status: 200 }),
    );
    await submitPlcOperation(DID, OP, {
      directoryUrl: "https://plc.example",
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://plc.example/${DID}`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual(OP);
  });

  it("normalises a trailing slash in the directory URL", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(null, { status: 200 }),
    );
    await submitPlcOperation(DID, OP, {
      directoryUrl: "https://plc.example/",
      fetchImpl,
    });
    expect(calls[0]!.url).toBe(`https://plc.example/${DID}`);
  });

  it("throws with the directory's status and body on rejection", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("invalid signature", { status: 400 }),
    );
    await expect(
      submitPlcOperation(DID, OP, {
        directoryUrl: "https://plc.example",
        fetchImpl,
      }),
    ).rejects.toThrow(/rejected the operation.*400.*invalid signature/s);
  });

  it("resolves a DID document, and returns null on 404", async () => {
    const doc = { id: DID };
    const ok = fakeFetch(
      () => new Response(JSON.stringify(doc), { status: 200 }),
    );
    expect(
      await resolvePlcDid(DID, {
        directoryUrl: "https://plc.example",
        fetchImpl: ok.fetchImpl,
      }),
    ).toEqual(doc);
    expect(ok.calls[0]!.url).toBe(`https://plc.example/${DID}`);

    const missing = fakeFetch(() => new Response(null, { status: 404 }));
    expect(
      await resolvePlcDid(DID, {
        directoryUrl: "https://plc.example",
        fetchImpl: missing.fetchImpl,
      }),
    ).toBeNull();
  });

  it("fetches the data state from /:did/data", async () => {
    const data = { rotationKeys: ["did:key:zQ3shrot"] };
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(JSON.stringify(data), { status: 200 }),
    );
    expect(
      await fetchPlcData(DID, {
        directoryUrl: "https://plc.example",
        fetchImpl,
      }),
    ).toEqual(data);
    expect(calls[0]!.url).toBe(`https://plc.example/${DID}/data`);
  });

  it("throws on a non-404 resolve error", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 500 }));
    await expect(
      resolvePlcDid(DID, {
        directoryUrl: "https://plc.example",
        fetchImpl,
      }),
    ).rejects.toThrow(/resolve failed.*500/s);
  });

  it("sends a timeout signal on every directory call", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("{}"));
    await resolvePlcDid("did:plc:abc", { fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchAllowedHosts (local-dev opt-in, issue #257)", () => {
  it("resolves against a loopback directory when its host is allowlisted", async () => {
    const doFetch: FetchLike = async () =>
      new Response(JSON.stringify({ id: DID }), {
        headers: { "content-type": "application/json" },
      });
    const doc = await resolvePlcDid(DID, {
      directoryUrl: "http://localhost:2582",
      fetchImpl: doFetch,
      fetchAllowedHosts: ["localhost:2582"],
    });
    expect(doc).toEqual({ id: DID });
  });

  it("still blocks a loopback directory the allowlist does not name", async () => {
    const doFetch: FetchLike = async () =>
      new Response(JSON.stringify({ id: DID }));
    await expect(
      resolvePlcDid(DID, {
        directoryUrl: "http://127.0.0.1:2582",
        fetchImpl: doFetch,
        fetchAllowedHosts: ["localhost:2582"],
      }),
    ).rejects.toThrow();
  });
});
