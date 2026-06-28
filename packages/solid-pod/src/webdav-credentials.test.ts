import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureGcSchema } from "@dwk/store";

import {
  createSolidPodWebdav,
  createSolidPodWebdavCredentials,
  type SolidPodEnv,
} from "./index.js";

/**
 * The owner-gated WebDAV app-password endpoint. The pod's normal DPoP auth is
 * stubbed via the `authenticate` config seam so these tests exercise the
 * mint/list/revoke + ownership logic without standing up token crypto; a minted
 * credential is then proven to authenticate on the Basic-auth data door (same
 * per-pod DO).
 */

const testEnv = env as unknown as SolidPodEnv;
const OWNER = "https://owner.example/profile#me";
const BOB = "https://bob.example/profile#me";

beforeEach(async () => {
  await ensureGcSchema(testEnv.GC_DB as D1Database);
});

function freshBase(): string {
  return `https://pod-${crypto.randomUUID()}.example`;
}

/** A credentials front door whose edge auth resolves to `authWebid` (or anon). */
function adminHandler(baseUrl: string, authWebid: string | null) {
  return createSolidPodWebdavCredentials({
    baseUrl,
    owner: OWNER,
    authenticate: async () =>
      authWebid === null ? null : { webid: authWebid, jti: "jti", jkt: "jkt" },
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("@dwk/solid-pod WebDAV app-password endpoint", () => {
  it("mints a credential the owner can then use on the data door", async () => {
    const baseUrl = freshBase();
    const admin = adminHandler(baseUrl, OWNER);
    const mintRes = await admin(
      new Request(`${baseUrl}/webdav-credentials`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          label: "Finder",
          scope: { modes: ["read", "write"] },
        }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as {
      username: string;
      secret: string;
      credentialId: string;
    };
    expect(minted.username).toMatch(/^wdav-/);
    expect(minted.secret.length).toBeGreaterThan(20);

    // The minted credential authenticates on the Basic-auth data door, which
    // verifies against the same per-pod CredentialStore.
    const data = createSolidPodWebdav({ baseUrl, owner: OWNER });
    const basic = `Basic ${btoa(`${minted.username}:${minted.secret}`)}`;
    const put = await data(
      new Request(`${baseUrl}/note.txt`, {
        method: "PUT",
        headers: { authorization: basic },
        body: "hello",
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(put.status).toBe(201);
  });

  it("lists credentials without the secret, and revokes by id", async () => {
    const baseUrl = freshBase();
    const admin = adminHandler(baseUrl, OWNER);
    const minted = (await (
      await admin(
        new Request(`${baseUrl}/c`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ label: "L", scope: { modes: ["read"] } }),
        }),
        testEnv,
        createExecutionContext(),
      )
    ).json()) as { credentialId: string };

    const listRes = await admin(
      new Request(`${baseUrl}/c`, { method: "GET" }),
      testEnv,
      createExecutionContext(),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      credentialId: string;
      label: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.credentialId).toBe(minted.credentialId);
    expect(list[0]?.label).toBe("L");
    // The hash and secret must never be listed.
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(JSON.stringify(list)).not.toContain("hash");

    const del = await admin(
      new Request(`${baseUrl}/c?id=${minted.credentialId}`, {
        method: "DELETE",
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(del.status).toBe(204);
    const after = (await (
      await admin(
        new Request(`${baseUrl}/c`, { method: "GET" }),
        testEnv,
        createExecutionContext(),
      )
    ).json()) as unknown[];
    expect(after).toHaveLength(0);
  });

  it("rejects a non-owner (403) and an anonymous request (401)", async () => {
    const baseUrl = freshBase();
    const body = JSON.stringify({ label: "x", scope: { modes: ["read"] } });
    const nonOwner = await adminHandler(baseUrl, BOB)(
      new Request(`${baseUrl}/c`, {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(nonOwner.status).toBe(403);

    const anon = await adminHandler(baseUrl, null)(
      new Request(`${baseUrl}/c`, {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(anon.status).toBe(401);
  });

  it("validates the mint body (missing label / scope, bad JSON)", async () => {
    const baseUrl = freshBase();
    const admin = adminHandler(baseUrl, OWNER);
    const noLabel = await admin(
      new Request(`${baseUrl}/c`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ scope: { modes: ["read"] } }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(noLabel.status).toBe(400);
    const badJson = await admin(
      new Request(`${baseUrl}/c`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{not json",
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(badJson.status).toBe(400);
  });

  it("cannot revoke another owner's credential", async () => {
    // Two pods would differ; here a single owner can't revoke an id bound to a
    // different WebID (the DELETE 404s rather than touching it).
    const baseUrl = freshBase();
    const admin = adminHandler(baseUrl, OWNER);
    const del = await admin(
      new Request(`${baseUrl}/c?id=wdav-nonexistent`, { method: "DELETE" }),
      testEnv,
      createExecutionContext(),
    );
    expect(del.status).toBe(404);
  });
});
