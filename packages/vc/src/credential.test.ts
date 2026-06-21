import { describe, expect, it } from "vitest";

import {
  buildCredential,
  checkValidityPeriod,
  issuerId,
  validateCredential,
  VC_CONTEXT_V2,
  VERIFIABLE_CREDENTIAL_TYPE,
} from "./credential.js";

describe("buildCredential", () => {
  it("puts the base context first and the base type present", () => {
    const cred = buildCredential({
      issuer: "did:web:example.com",
      credentialSubject: { id: "did:web:alice.example", name: "Alice" },
    });
    expect((cred["@context"] as string[])[0]).toBe(VC_CONTEXT_V2);
    expect(cred.type).toContain(VERIFIABLE_CREDENTIAL_TYPE);
    expect(typeof cred.validFrom).toBe("string");
  });

  it("merges extra contexts and types without duplicating the base", () => {
    const cred = buildCredential({
      issuer: "did:web:example.com",
      credentialSubject: {},
      context: [VC_CONTEXT_V2, "https://example.com/ctx"],
      type: ["VerifiableCredential", "AlumniCredential"],
    });
    expect(cred["@context"]).toEqual([
      VC_CONTEXT_V2,
      "https://example.com/ctx",
    ]);
    expect(cred.type).toEqual(["VerifiableCredential", "AlumniCredential"]);
  });

  it("carries id, validUntil, and credentialStatus when supplied", () => {
    const cred = buildCredential({
      id: "https://example.com/creds/1",
      issuer: { id: "did:web:example.com", name: "Example" },
      credentialSubject: { id: "x" },
      validUntil: "2030-01-01T00:00:00Z",
      credentialStatus: { type: "BitstringStatusListEntry" },
    });
    expect(cred.id).toBe("https://example.com/creds/1");
    expect(cred.validUntil).toBe("2030-01-01T00:00:00Z");
    expect(cred.credentialStatus).toEqual({ type: "BitstringStatusListEntry" });
  });

  it("rejects an invalid validUntil datetime", () => {
    expect(() =>
      buildCredential({
        issuer: "did:web:example.com",
        credentialSubject: {},
        validUntil: "not-a-date",
      }),
    ).toThrow(/dateTimeStamp/);
  });
});

describe("validateCredential", () => {
  it("accepts a well-formed credential", () => {
    const cred = buildCredential({
      issuer: "did:web:example.com",
      credentialSubject: { id: "did:web:alice.example" },
    });
    expect(validateCredential(cred)).toEqual([]);
  });

  it("flags a missing base context, type, issuer, and subject", () => {
    const errors = validateCredential({
      "@context": ["https://example.com/other"],
      type: ["Foo"],
      issuer: 42,
      credentialSubject: "not-an-object",
    });
    expect(errors).toHaveLength(4);
  });
});

describe("issuerId", () => {
  it("reads a string or object issuer", () => {
    expect(issuerId({ issuer: "did:web:example.com" })).toBe(
      "did:web:example.com",
    );
    expect(issuerId({ issuer: { id: "did:web:example.com" } })).toBe(
      "did:web:example.com",
    );
    expect(issuerId({ issuer: 1 })).toBeUndefined();
  });
});

describe("checkValidityPeriod", () => {
  const now = Date.parse("2026-06-04T00:00:00Z");

  it("returns null inside the window", () => {
    expect(
      checkValidityPeriod(
        {
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: "2027-01-01T00:00:00Z",
        },
        now,
      ),
    ).toBeNull();
  });

  it("detects not-yet-valid and expired", () => {
    expect(
      checkValidityPeriod({ validFrom: "2030-01-01T00:00:00Z" }, now),
    ).toBe("not_yet_valid");
    expect(
      checkValidityPeriod({ validUntil: "2020-01-01T00:00:00Z" }, now),
    ).toBe("expired");
  });

  it("fails closed on a malformed or non-string bound", () => {
    // A garbled expiry must not be read as "no expiry".
    expect(checkValidityPeriod({ validUntil: "not-a-date" }, now)).toBe(
      "expired",
    );
    expect(
      checkValidityPeriod({ validUntil: "2026-02-30T00:00:00Z" }, now),
    ).toBe("expired");
    expect(
      checkValidityPeriod({ validUntil: 1234 as unknown as string }, now),
    ).toBe("expired");
    expect(checkValidityPeriod({ validFrom: "nope" }, now)).toBe(
      "not_yet_valid",
    );
  });

  it("rejects a validUntil without a timezone (not a dateTimeStamp)", () => {
    expect(
      checkValidityPeriod({ validUntil: "2027-01-01T00:00:00" }, now),
    ).toBe("expired");
  });
});
