import { describe, expect, it } from "vitest";

import type { ClientRecord } from "@dwk/oauth";

import type { MastodonApiConfig } from "./config.js";
import {
  TRANSPARENT_PIXEL,
  applicationEntity,
  compatibilityVersion,
  credentialAccountEntity,
  instanceV1Entity,
  instanceV2Entity,
  markerEntity,
} from "./entities.js";

const record: ClientRecord = {
  clientId: "client-1",
  clientIdIssuedAt: 1_700_000_000,
  clientSecret: "hash-of-secret",
  metadata: {
    client_name: "Tusky",
    redirect_uris: ["app://oauth-callback", "urn:ietf:wg:oauth:2.0:oob"],
    scope: "read write follow push",
    client_uri: "https://tusky.app",
  },
};

const config: MastodonApiConfig = {
  baseUrl: "https://owner.example",
  instance: {
    title: "Owner's site",
    description: "A personal site",
    contactEmail: "me@owner.example",
    languages: ["en"],
    thumbnail: "https://owner.example/thumb.png",
  },
  account: {
    username: "owner",
    displayName: "The Owner",
    note: "<p>hi</p>",
    url: "https://owner.example/@owner",
    avatar: "https://owner.example/avatar.png",
    createdAt: "2024-01-01T00:00:00.000Z",
  },
  approveAuthorization: async () => ({ approved: true }),
  softwareVersion: "0.1.0",
};

const minimal: MastodonApiConfig = {
  baseUrl: "https://owner.example",
  instance: { title: "Owner's site" },
  account: { username: "owner" },
  approveAuthorization: async () => ({ approved: true }),
};

describe("applicationEntity", () => {
  it("emits the registration response with one-time credentials", () => {
    expect(applicationEntity(record, { clientSecret: "plaintext" })).toEqual({
      id: "1700000000",
      name: "Tusky",
      website: "https://tusky.app",
      redirect_uri: "app://oauth-callback\nurn:ietf:wg:oauth:2.0:oob",
      redirect_uris: ["app://oauth-callback", "urn:ietf:wg:oauth:2.0:oob"],
      scopes: ["read", "write", "follow", "push"],
      client_id: "client-1",
      client_secret: "plaintext",
    });
  });

  it("omits credentials (and never emits vapid_key) without the secret", () => {
    const entity = applicationEntity(record);
    expect(entity).not.toHaveProperty("client_id");
    expect(entity).not.toHaveProperty("client_secret");
    expect(entity).not.toHaveProperty("vapid_key");
    expect(entity.name).toBe("Tusky");
  });
});

describe("credentialAccountEntity", () => {
  it("emits every required field from a full config", () => {
    const counts = { followers: 2, following: 3, statuses: 5 };
    expect(credentialAccountEntity(config, counts)).toEqual({
      id: "1",
      username: "owner",
      acct: "owner",
      display_name: "The Owner",
      locked: false,
      bot: false,
      discoverable: true,
      group: false,
      created_at: "2024-01-01T00:00:00.000Z",
      note: "<p>hi</p>",
      url: "https://owner.example/@owner",
      avatar: "https://owner.example/avatar.png",
      avatar_static: "https://owner.example/avatar.png",
      header: TRANSPARENT_PIXEL,
      header_static: TRANSPARENT_PIXEL,
      followers_count: 2,
      following_count: 3,
      statuses_count: 5,
      last_status_at: null,
      emojis: [],
      fields: [],
      source: {
        privacy: "public",
        sensitive: false,
        language: null,
        note: "<p>hi</p>",
        fields: [],
        follow_requests_count: 0,
      },
    });
  });

  it("applies defaults for a minimal config", () => {
    const entity = credentialAccountEntity(minimal, {
      followers: 0,
      following: 0,
      statuses: 0,
    });
    expect(entity.display_name).toBe("owner");
    expect(entity.note).toBe("");
    expect(entity.url).toBe("https://owner.example/users/owner");
    expect(entity.avatar).toBe(TRANSPARENT_PIXEL);
    expect(entity.created_at).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("instance entities", () => {
  it("builds the compatibility version string", () => {
    expect(compatibilityVersion(config)).toBe(
      "4.2.0 (compatible; dwk-workers/0.1.0)",
    );
    expect(compatibilityVersion(minimal)).toBe(
      "4.2.0 (compatible; dwk-workers/0)",
    );
  });

  it("emits v1 without a streaming URL and with closed registrations", () => {
    const v1 = instanceV1Entity(config, "owner.example");
    expect(v1.uri).toBe("owner.example");
    expect(v1.title).toBe("Owner's site");
    expect(v1.email).toBe("me@owner.example");
    expect(v1.urls).toEqual({});
    expect(v1.stats).toEqual({
      user_count: 1,
      status_count: 0,
      domain_count: 0,
    });
    expect(v1.registrations).toBe(false);
    expect(v1.version).toBe("4.2.0 (compatible; dwk-workers/0.1.0)");
  });

  it("emits v2 with domain, usage, and closed registrations", () => {
    const v2 = instanceV2Entity(config, "owner.example");
    expect(v2.domain).toBe("owner.example");
    expect(v2.usage).toEqual({ users: { active_month: 1 } });
    expect(v2.registrations).toEqual({
      enabled: false,
      approval_required: true,
      message: null,
    });
    expect(v2.contact).toEqual({ email: "me@owner.example", account: null });
    expect(v2.rules).toEqual([]);
  });
});

describe("markerEntity", () => {
  it("serializes with an ISO timestamp", () => {
    expect(
      markerEntity({
        timeline: "home",
        lastReadId: "101",
        version: 3,
        updatedAt: 1_700_000_000,
      }),
    ).toEqual({
      last_read_id: "101",
      version: 3,
      updated_at: "2023-11-14T22:13:20.000Z",
    });
  });
});
