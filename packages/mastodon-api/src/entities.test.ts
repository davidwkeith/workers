import { describe, expect, it } from "vitest";

import type { ClientRecord } from "@dwk/oauth";

import type { MastodonApiConfig } from "./config.js";
import {
  TRANSPARENT_PIXEL,
  applicationEntity,
  compatibilityVersion,
  credentialAccountEntity,
  decodeRemoteAccountId,
  encodeRemoteAccountId,
  instanceV1Entity,
  instanceV2Entity,
  markerEntity,
  notificationEntity,
  remoteAccountEntity,
  statusEntity,
} from "./entities.js";
import { encodeSnowflake } from "./snowflake.js";
import type { BackendEntry } from "./backend.js";

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

describe("statusEntity", () => {
  const baseUrl = "https://owner.example";

  it("maps a Create/Note to a Status with sanitized content and CW", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_000, 1),
      receivedAt: 1_753_000_000_000,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/1",
        type: "Create",
        actor: "https://remote.example/users/alice",
        object: {
          id: "https://remote.example/objects/1",
          type: "Note",
          content: "<p>hi <script>bad()</script></p>",
          summary: "cw text",
          sensitive: true,
          attachment: [
            {
              type: "Image",
              url: "https://remote.example/media/1.jpg",
              mediaType: "image/jpeg",
              name: "alt text",
            },
          ],
        },
      },
    };
    const status = statusEntity(entry, { baseUrl });
    expect(status.id).toBe(entry.id);
    expect(status.content).toBe("<p>hi </p>");
    expect(status.spoiler_text).toBe("cw text");
    expect(status.sensitive).toBe(true);
    expect((status.media_attachments as unknown[])[0]).toMatchObject({
      type: "image",
      url: "https://remote.example/media/1.jpg",
      description: "alt text",
    });
    expect((status.account as { acct: string }).acct).toContain("alice");
  });

  it("wraps a relayed_by row as a reblog attributed to the relaying group", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_001, 1),
      receivedAt: 1_753_000_000_001,
      objectType: "Note",
      relayedBy: "https://lemmy.example/c/birding",
      activity: {
        id: "https://remote.example/activities/2",
        type: "Create",
        actor: "https://remote.example/users/bob",
        object: {
          id: "https://remote.example/objects/2",
          type: "Note",
          content: "<p>bird</p>",
        },
      },
    };
    const status = statusEntity(entry, { baseUrl });
    expect((status.account as { acct: string }).acct).toContain("birding");
    expect(status.reblog).not.toBeNull();
    expect((status.reblog as { content: string }).content).toBe("<p>bird</p>");
  });

  it("does not throw and produces safe empty content when object.content is a number", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_002, 1),
      receivedAt: 1_753_000_000_002,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/3",
        type: "Create",
        actor: "https://remote.example/users/carol",
        object: {
          id: "https://remote.example/objects/3",
          type: "Note",
          content: 123,
        },
      },
    };
    expect(() => statusEntity(entry, { baseUrl })).not.toThrow();
    const status = statusEntity(entry, { baseUrl });
    expect(status.content).toBe("");
  });

  it("does not throw and produces safe empty content when object.content is a plain object", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_003, 1),
      receivedAt: 1_753_000_000_003,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/4",
        type: "Create",
        actor: "https://remote.example/users/dave",
        object: {
          id: "https://remote.example/objects/4",
          type: "Note",
          content: { malicious: "<script>bad()</script>" },
        },
      },
    };
    expect(() => statusEntity(entry, { baseUrl })).not.toThrow();
    const status = statusEntity(entry, { baseUrl });
    expect(status.content).toBe("");
  });

  it("falls back to safe defaults when summary/sensitive are the wrong type", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_004, 1),
      receivedAt: 1_753_000_000_004,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/5",
        type: "Create",
        actor: "https://remote.example/users/erin",
        object: {
          id: "https://remote.example/objects/5",
          type: "Note",
          content: "<p>hi</p>",
          summary: 123,
          sensitive: "yes",
        },
      },
    };
    const status = statusEntity(entry, { baseUrl });
    expect(status.spoiler_text).toBe("");
    expect(status.sensitive).toBe(false);
  });
});

describe("remote account id round trip", () => {
  it("encodes and decodes the actor IRI", () => {
    const iri = "https://remote.example/users/alice";
    const id = encodeRemoteAccountId(iri);
    expect(id.startsWith("r_")).toBe(true);
    expect(decodeRemoteAccountId(id)).toBe(iri);
  });

  it("synthesizes username/acct/url from the IRI shape", () => {
    const account = remoteAccountEntity("https://remote.example/users/alice");
    expect(account.username).toBe("alice");
    expect(account.acct).toBe("alice@remote.example");
    expect(account.url).toBe("https://remote.example/users/alice");
    expect(account.avatar).toBeTruthy();
  });

  it("round-trips a non-ASCII (RFC 3987 IRI) actor id without throwing", () => {
    const iri = "https://remote.example/users/日本";
    expect(() => encodeRemoteAccountId(iri)).not.toThrow();
    const id = encodeRemoteAccountId(iri);
    expect(id.startsWith("r_")).toBe(true);
    expect(decodeRemoteAccountId(id)).toBe(iri);
  });

  it("round-trips a mix of emoji and multi-byte scripts", () => {
    const iri = "https://remote.example/users/名前🎉café";
    const id = encodeRemoteAccountId(iri);
    expect(decodeRemoteAccountId(id)).toBe(iri);
  });
});

describe("notificationEntity", () => {
  const baseUrl = "https://owner.example";

  it("maps a Like to a favourite notification", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_002, 1),
      receivedAt: 1_753_000_000_002,
      objectType: null,
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/3",
        type: "Like",
        actor: "https://remote.example/users/carol",
        object: `${baseUrl}/users/owner/outbox/1`,
      },
    };
    const notification = notificationEntity(entry, { baseUrl });
    expect(notification).not.toBeNull();
    expect(notification!.type).toBe("favourite");
    expect((notification!.account as { acct: string }).acct).toContain("carol");
  });

  it("maps an Announce to a reblog notification", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_003, 1),
      receivedAt: 1_753_000_000_003,
      objectType: null,
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/4",
        type: "Announce",
        actor: "https://remote.example/users/dave",
        object: `${baseUrl}/users/owner/outbox/1`,
      },
    };
    expect(notificationEntity(entry, { baseUrl })!.type).toBe("reblog");
  });

  it("maps a reply Create into this actor's namespace to a mention notification", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_004, 1),
      receivedAt: 1_753_000_000_004,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/5",
        type: "Create",
        actor: "https://remote.example/users/erin",
        object: {
          id: "https://remote.example/objects/5",
          type: "Note",
          content: "<p>reply</p>",
          inReplyTo: `${baseUrl}/users/owner/outbox/1`,
        },
      },
    };
    const notification = notificationEntity(entry, { baseUrl });
    expect(notification!.type).toBe("mention");
    expect(notification!.status).toBeTruthy();
  });

  it("returns null for a plain top-level Create with no reply target", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_005, 1),
      receivedAt: 1_753_000_000_005,
      objectType: "Note",
      relayedBy: null,
      activity: {
        type: "Create",
        actor: "https://remote.example/users/frank",
        object: { type: "Note", content: "<p>unrelated</p>" },
      },
    };
    expect(notificationEntity(entry, { baseUrl })).toBeNull();
  });

  // Regression tests for the Task 5 lesson: every field read off
  // entry.activity is attacker-controlled remote AS2 JSON and must be
  // individually type-guarded, never trusted as the "obviously right"
  // type. These cover the two guards specific to notificationEntity:
  // activity.object as a non-object, and activity.type as a non-string.

  it("does not throw when a Create's object is a bare IRI reference, not an embedded object", () => {
    // A realistic bare-IRI-Announce/reply-by-reference shape: some remote
    // implementations send `object` as a plain string IRI rather than an
    // embedded object, even on a Create. There is no `inReplyTo` to read
    // off a string, so this must fall through to null, not crash.
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_006, 1),
      receivedAt: 1_753_000_000_006,
      objectType: "Note",
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/6",
        type: "Create",
        actor: "https://remote.example/users/grace",
        object: "https://remote.example/objects/6",
      },
    };
    expect(() => notificationEntity(entry, { baseUrl })).not.toThrow();
    expect(notificationEntity(entry, { baseUrl })).toBeNull();
  });

  it("does not throw and returns null when activity.type is not a string", () => {
    const entry: BackendEntry = {
      id: encodeSnowflake(1_753_000_000_007, 1),
      receivedAt: 1_753_000_000_007,
      objectType: null,
      relayedBy: null,
      activity: {
        id: "https://remote.example/activities/7",
        type: 12345,
        actor: "https://remote.example/users/heidi",
        object: `${baseUrl}/users/owner/outbox/1`,
      },
    };
    expect(() => notificationEntity(entry, { baseUrl })).not.toThrow();
    expect(notificationEntity(entry, { baseUrl })).toBeNull();
  });
});
