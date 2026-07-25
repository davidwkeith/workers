# ActivityPub Outbox Backfill Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a quiet-insert mode (`skipDelivery`) and a caller-supplied `published` timestamp override to `@dwk/activitypub`'s owner-publish seam (`POST <actor>/outbox` and `POST <actor>/publish`), plus order the outbox `OrderedCollection` by `published_at`, so a trusted owner script can backfill historical posts without notification-blasting today's followers. Design: [`docs/superpowers/specs/2026-07-24-activitypub-outbox-quiet-insert-design.md`](../specs/2026-07-24-activitypub-outbox-quiet-insert-design.md). Issue: [#451](https://github.com/davidwkeith/workers/issues/451).

**Architecture:** A `?skipDelivery=1` query param on the existing bearer-token-gated publish endpoints is translated by the front door (`handler.ts`) into a new internal header (`INTERNAL_HEADERS.skipDelivery`), mirroring the existing `publish`/`internal` trust-boundary pattern. The per-actor Durable Object (`object.ts`) reads that header to skip follower fan-out, relationship routing, and alarm arming, while a caller-supplied `published` (validated ISO-8601) survives instead of being overwritten with `now()`. The outbox's page query switches from `ORDER BY seq DESC` to `ORDER BY published_at DESC, seq DESC`.

**Tech Stack:** TypeScript (strict), Cloudflare Workers Durable Objects, Vitest via `@cloudflare/vitest-pool-workers` (workerd runtime), pnpm workspace.

## Global Constraints

- ESM-only, TypeScript strict mode (`noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`) — use `import type` for type-only imports.
- Prettier formatting: semicolons, double quotes, trailing commas (`all`), 80-column width. Run `pnpm format` before committing; `pnpm format:check` is a CI gate.
- Commit messages: Conventional Commits, `<type>(<scope>): <subject>`, lowercase type, subject not capitalized, scope `activitypub` for every commit in this plan.
- `@dwk/activitypub` tests run under `workerd` via `@cloudflare/vitest-pool-workers`. Run with `pnpm test --project @dwk/activitypub` (or add `-t "<name>"` / a filename substring to target one test).
- CI (`.github/workflows/ci.yml`) runs, in order: lint → format:check → typecheck → build → test. Match these locally before pushing: `pnpm lint`, `pnpm format:check`, `pnpm --filter @dwk/activitypub typecheck`, `pnpm --filter @dwk/activitypub build`, `pnpm test --project @dwk/activitypub`.
- Packages never read the global environment directly; all config flows through the factory (not touched by this plan — no new `ActivityPubConfig` fields are needed, only new internal headers and request params).
- Versioning: Changesets pre mode. Record the change with a `.changeset/*.md` file (not the interactive `pnpm changeset` CLI, which can't run non-interactively) — see Task 6.

---

### Task 1: `isValidPublished` + `PostInput.published` + `parsePostInput` validation

**Files:**
- Modify: `packages/activitypub/src/objects.ts`
- Test: `packages/activitypub/src/objects.test.ts`

**Interfaces:**
- Produces: `export function isValidPublished(value: unknown): value is string` — true iff `value` is a non-empty string `Date.parse` can interpret. `PostInput.published?: string`. `parsePostInput` rejects an unparseable `published` with a client-facing error and otherwise carries it into the returned `input`.
- Consumed by: Task 2 (`object.ts` `#asOutboxActivity`/`#publish`) and Task 3 (`object.ts` `#storePost`).

- [ ] **Step 1: Write the failing tests**

In `packages/activitypub/src/objects.test.ts`, add `isValidPublished` to the existing import from `./objects.js`:

```ts
import {
  buildAnnounceActivity,
  buildPostActivity,
  buildPostObject,
  classifyActivity,
  isValidPublished,
  parsePostInput,
  postAddressing,
} from "./objects.js";
```

Add this test inside the existing `describe("parsePostInput", ...)` block, right after the `it("rejects a non-boolean sensitive flag", ...)` test (before the block's closing `});`):

```ts
  it("validates published as an ISO-8601 timestamp", () => {
    expect(
      rejected({ kind: "note", content: "x", published: "not-a-date" }),
    ).toMatch(/`published`/);
    const input = parsed({
      kind: "note",
      content: "x",
      published: "2019-03-01T12:00:00.000Z",
    });
    expect(input.published).toBe("2019-03-01T12:00:00.000Z");
  });
```

Add a new top-level `describe` block at the end of the file (after the last existing `describe` block):

```ts
describe("isValidPublished", () => {
  it("accepts parseable ISO-8601 strings and rejects everything else", () => {
    expect(isValidPublished("2019-03-01T12:00:00.000Z")).toBe(true);
    expect(isValidPublished("not-a-date")).toBe(false);
    expect(isValidPublished("")).toBe(false);
    expect(isValidPublished(undefined)).toBe(false);
    expect(isValidPublished(12345)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub objects.test`
Expected: FAIL — `isValidPublished` is not exported from `./objects.js`, and the `published` assertions fail (the field is silently dropped / not validated).

- [ ] **Step 3: Implement**

In `packages/activitypub/src/objects.ts`, add `published?: string` to `PostInput` (find the interface — it ends with `cc`):

```ts
  /** Advanced addressing override — mentions / secondary audiences (`cc`). */
  readonly cc?: readonly string[];
}
```

Replace with:

```ts
  /** Advanced addressing override — mentions / secondary audiences (`cc`). */
  readonly cc?: readonly string[];
  /**
   * ISO-8601 publish timestamp override. Defaults to `now`; used to backdate
   * backfilled historical content so it doesn't sort as newly posted (#451).
   */
  readonly published?: string;
}
```

Add the validation helper right after `isAddressable` (find):

```ts
function isAddressable(value: string): boolean {
  return value === PUBLIC_AUDIENCE || isHttpUrl(value);
}
```

Replace with:

```ts
function isAddressable(value: string): boolean {
  return value === PUBLIC_AUDIENCE || isHttpUrl(value);
}

/**
 * Whether `value` is a non-empty string `Date.parse` can interpret — the
 * shared validity check for a caller-supplied `published` override on both
 * the raw-AS2 and shaped-post publish paths (#451).
 */
export function isValidPublished(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}
```

Add `published?: string;` to the inline `input` object type inside `parsePostInput` (find):

```ts
  const input: {
    kind: PostKind;
    content: string;
    name?: string;
    summary?: string;
    sensitive?: boolean;
    attachments?: PostAttachment[];
    inReplyTo?: string;
    audience?: string;
    tags?: string[];
    to?: string[];
    cc?: string[];
  } = { kind: kind as PostKind, content };
```

Replace with:

```ts
  const input: {
    kind: PostKind;
    content: string;
    name?: string;
    summary?: string;
    sensitive?: boolean;
    attachments?: PostAttachment[];
    inReplyTo?: string;
    audience?: string;
    tags?: string[];
    to?: string[];
    cc?: string[];
    published?: string;
  } = { kind: kind as PostKind, content };
```

Add the validation block right after the `sensitive` check and before the `inReplyTo`/`audience` loop (find):

```ts
  if (record.sensitive !== undefined) {
    if (typeof record.sensitive !== "boolean") {
      return { ok: false, error: "`sensitive` must be a boolean" };
    }
    input.sensitive = record.sensitive;
  }

  for (const key of ["inReplyTo", "audience"] as const) {
```

Replace with:

```ts
  if (record.sensitive !== undefined) {
    if (typeof record.sensitive !== "boolean") {
      return { ok: false, error: "`sensitive` must be a boolean" };
    }
    input.sensitive = record.sensitive;
  }

  if (record.published !== undefined) {
    const published = record.published;
    if (!isValidPublished(published)) {
      return {
        ok: false,
        error: "`published` must be a valid ISO-8601 timestamp",
      };
    }
    input.published = published;
  }

  for (const key of ["inReplyTo", "audience"] as const) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub objects.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/objects.ts packages/activitypub/src/objects.test.ts
git commit -m "feat(activitypub): accept a validated published override on PostInput"
```

---

### Task 2: raw-AS2 publish path — preserve `published`, add quiet-insert

**Files:**
- Modify: `packages/activitypub/src/config.ts`
- Modify: `packages/activitypub/src/object.ts`
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**
- Consumes: `isValidPublished` from Task 1 (`./objects.js`).
- Produces: `INTERNAL_HEADERS.skipDelivery = "x-ap-skip-delivery"` — consumed by Task 3 (`#storePost`/`#publishPost`) and Task 5 (`handler.ts`).

- [ ] **Step 1: Write the failing tests**

In `packages/activitypub/src/object.test.ts`, extend the `outboxRequest` helper with an optional `skipDelivery` parameter (find):

```ts
/** A POST to the outbox, optionally flagged as an owner publish. */
function outboxRequest(
  username: string,
  body: string,
  publish: boolean,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/activity+json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  return new Request(iris.outbox, { method: "POST", headers, body });
}
```

Replace with:

```ts
/** A POST to the outbox, optionally flagged as an owner publish. */
function outboxRequest(
  username: string,
  body: string,
  publish: boolean,
  skipDelivery = false,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/activity+json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  if (skipDelivery) headers[INTERNAL_HEADERS.skipDelivery] = "1";
  return new Request(iris.outbox, { method: "POST", headers, body });
}
```

Add these tests inside `describe("publish endpoint", ...)`, right after the `it("fans a published Note out to followers with a known inbox", ...)` test (before the block's closing `});`):

```ts
  it("preserves a caller-supplied published timestamp on a bare object", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Note",
            content: "old post",
            published: "2019-03-01T12:00:00.000Z",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.published).toBe("2019-03-01T12:00:00.000Z");
      const object = activity.object as Record<string, unknown>;
      expect(object.published).toBe("2019-03-01T12:00:00.000Z");
      const row = state.storage.sql
        .exec<{ published_at: number }>(
          `SELECT published_at FROM outbox WHERE id = ?`,
          activity.id,
        )
        .one();
      expect(row.published_at).toBe(Date.parse("2019-03-01T12:00:00.000Z"));
    });
  });

  it("preserves a caller-supplied published timestamp on a pre-wrapped activity", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Announce",
            object: "https://remote.example/notes/1",
            published: "2018-01-01T00:00:00.000Z",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.published).toBe("2018-01-01T00:00:00.000Z");
    });
  });

  it("400s an unparseable published timestamp", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Note", content: "x", published: "nope" }),
          true,
        ),
      );
      expect(res.status).toBe(400);
    });
  });

  it("skipDelivery inserts into the outbox without fan-out or arming the alarm", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Note", content: "backfilled" }),
          true,
          true,
        ),
      );
      expect(res.status).toBe(201);
      const outboxCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxCount).toBe(1);
      const deliveryCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(deliveryCount).toBe(0);
    });
  });

  it("skipDelivery on a Follow does not record a relationship or queue delivery", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Follow", object: REMOTE }),
          true,
          true,
        ),
      );
      expect(res.status).toBe(201);
      const followingCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM following`)
        .one().n;
      expect(followingCount).toBe(0);
      const pendingCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
        .one().n;
      expect(pendingCount).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub object.test -t "publish endpoint"`
Expected: FAIL — `published` is always overwritten with `now`, there is no `INTERNAL_HEADERS.skipDelivery`, and skipDelivery has no effect (delivery/following rows are still created).

- [ ] **Step 3: Implement**

In `packages/activitypub/src/config.ts`, add the new header (find, inside `INTERNAL_HEADERS`):

```ts
  /** Marks an owner-authorized publish request (`POST <actor>/outbox`). */
  publish: "x-ap-publish",
  /**
```

Replace with:

```ts
  /** Marks an owner-authorized publish request (`POST <actor>/outbox`). */
  publish: "x-ap-publish",
  /**
   * Marks an owner-authorized quiet-insert publish (`?skipDelivery=1` on
   * `POST <actor>/outbox` or `POST <actor>/publish`): insert into the outbox
   * without follower fan-out, relationship routing, community delivery, or
   * arming the delivery alarm — the backfill seam (#451).
   */
  skipDelivery: "x-ap-skip-delivery",
  /**
```

In `packages/activitypub/src/object.ts`, add `isValidPublished` to the `objects.js` import (find):

```ts
import {
  buildAnnounceActivity,
  buildPostActivity,
  classifyActivity,
  parsePostInput,
  type PostInput,
} from "./objects.js";
```

Replace with:

```ts
import {
  buildAnnounceActivity,
  buildPostActivity,
  classifyActivity,
  isValidPublished,
  parsePostInput,
  type PostInput,
} from "./objects.js";
```

Replace the whole `#publish` method (find):

```ts
  async #publish(request: Request): Promise<Response> {
    const config = this.#config!;
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let input: ActivityObject;
    try {
      input = (await request.json()) as ActivityObject;
    } catch {
      return text(400, "Malformed activity JSON");
    }

    const activity = this.#asOutboxActivity(input, config.iris);
    const id = activity.id as string;
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.now(),
    );

    const body = JSON.stringify(activity);
```

Replace with:

```ts
  async #publish(request: Request): Promise<Response> {
    const config = this.#config!;
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let input: ActivityObject;
    try {
      input = (await request.json()) as ActivityObject;
    } catch {
      return text(400, "Malformed activity JSON");
    }
    if (input.published !== undefined && !isValidPublished(input.published)) {
      return text(400, "`published` must be a valid ISO-8601 timestamp");
    }

    const activity = this.#asOutboxActivity(input, config.iris);
    const id = activity.id as string;
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(activity),
      Date.parse(activity.published as string),
    );

    // Quiet-insert mode (#451, backfill): write the historical activity to
    // the outbox and stop — no follower fan-out, no relationship routing (a
    // backfilled Follow shouldn't record a live relationship), no community
    // delivery, no alarm. Set only by an owner request the front door
    // already authorized (`?skipDelivery=1` on this endpoint).
    if (request.headers.get(INTERNAL_HEADERS.skipDelivery) === "1") {
      return json(201, activity as JsonValue, { location: id });
    }

    const body = JSON.stringify(activity);
```

Replace `#asOutboxActivity` (find):

```ts
  /** Wrap a bare object in a `Create`, assign ids/audience, and timestamp it. */
  #asOutboxActivity(
    input: ActivityObject,
    iris: ActorIris,
  ): Record<string, JsonValue> {
    const isActivity =
      typeof input.type === "string" &&
      [
        "Create",
        "Update",
        "Delete",
        "Announce",
        "Like",
        "Dislike",
        "Follow",
        "Undo",
      ].includes(input.type);
    const published = new Date().toISOString();
    const activityId = `${iris.outbox}/${crypto.randomUUID()}`;
```

Replace with:

```ts
  /**
   * Wrap a bare object in a `Create`, assign ids/audience, and timestamp it.
   * A caller-supplied `published` (already validated by `#publish`) is
   * preserved instead of stamped to `now` — the backfill seam (#451).
   */
  #asOutboxActivity(
    input: ActivityObject,
    iris: ActorIris,
  ): Record<string, JsonValue> {
    const isActivity =
      typeof input.type === "string" &&
      [
        "Create",
        "Update",
        "Delete",
        "Announce",
        "Like",
        "Dislike",
        "Follow",
        "Undo",
      ].includes(input.type);
    const published = isValidPublished(input.published)
      ? input.published
      : new Date().toISOString();
    const activityId = `${iris.outbox}/${crypto.randomUUID()}`;
```

(The rest of `#asOutboxActivity`, `#routeRelationshipActivity`, and the follower-loop/`#deliverToAudience`/`#armAlarm` tail of `#publish` are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub object.test -t "publish endpoint"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/config.ts packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): quiet-insert and backdated published on the raw-AS2 outbox path"
```

---

### Task 3: shaped-post publish path — preserve `published`, add quiet-insert

**Files:**
- Modify: `packages/activitypub/src/object.ts`
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**
- Consumes: `PostInput.published` and `isValidPublished` from Task 1; `INTERNAL_HEADERS.skipDelivery` from Task 2.
- Produces: `#storePost(input: PostInput, opts?: { skipDelivery?: boolean })` — `opts` defaults to `{}`, so the existing `#clientPublish` call site (unchanged, no `opts` argument) keeps its current live-publish behavior.

- [ ] **Step 1: Write the failing tests**

In `packages/activitypub/src/object.test.ts`, extend the `publishRequest` helper with an optional `skipDelivery` parameter (find):

```ts
/** A POST to the shaped-post publish endpoint. */
function publishRequest(
  username: string,
  body: string,
  publish = true,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  return new Request(`${iris.id}/publish`, { method: "POST", headers, body });
}
```

Replace with:

```ts
/** A POST to the shaped-post publish endpoint. */
function publishRequest(
  username: string,
  body: string,
  publish = true,
  skipDelivery = false,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  if (skipDelivery) headers[INTERNAL_HEADERS.skipDelivery] = "1";
  return new Request(`${iris.id}/publish`, { method: "POST", headers, body });
}
```

Add these tests inside `describe("shaped post publish endpoint", ...)`, right after the `it("publishes a media note: minted ids, outbox row, follower fan-out", ...)` test (before `it("publishes a titled Page carrying the community audience", ...)`):

```ts
  it("preserves a caller-supplied published timestamp", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({
            kind: "note",
            content: "old post",
            published: "2019-03-01T12:00:00.000Z",
          }),
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      const object = activity.object as Record<string, unknown>;
      expect(activity.published).toBe("2019-03-01T12:00:00.000Z");
      expect(object.published).toBe("2019-03-01T12:00:00.000Z");
      const row = state.storage.sql
        .exec<{ published_at: number }>(
          `SELECT published_at FROM outbox WHERE id = ?`,
          activity.id,
        )
        .one();
      expect(row.published_at).toBe(Date.parse("2019-03-01T12:00:00.000Z"));
    });
  });

  it("400s an unparseable published timestamp", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({ kind: "note", content: "x", published: "nope" }),
        ),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/`published`/);
    });
  });

  it("skipDelivery inserts a shaped post without fan-out or arming the alarm", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({ kind: "note", content: "backfilled" }),
          true,
          true,
        ),
      );
      expect(res.status).toBe(201);
      const outboxed = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxed).toBe(1);
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub object.test -t "shaped post publish endpoint"`
Expected: FAIL — `#storePost` always stamps `published: new Date().toISOString()` and has no `skipDelivery` parameter.

- [ ] **Step 3: Implement**

In `packages/activitypub/src/object.ts`, replace `#publishPost` (find):

```ts
  async #publishPost(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(400, "Malformed post JSON");
    }
    const parsed = parsePostInput(body);
    if (!parsed.ok) return text(400, parsed.error);

    const stored = await this.#storePost(parsed.input);
    return json(201, stored.activity as JsonValue, {
      location: stored.activityId,
    });
  }
```

Replace with:

```ts
  async #publishPost(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADERS.publish) !== "1") {
      return text(403, "Publishing is not enabled");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(400, "Malformed post JSON");
    }
    const parsed = parsePostInput(body);
    if (!parsed.ok) return text(400, parsed.error);

    const skipDelivery =
      request.headers.get(INTERNAL_HEADERS.skipDelivery) === "1";
    const stored = await this.#storePost(parsed.input, { skipDelivery });
    return json(201, stored.activity as JsonValue, {
      location: stored.activityId,
    });
  }
```

Replace `#storePost` (find):

```ts
  async #storePost(input: PostInput): Promise<{
    activityId: string;
    activity: Record<string, JsonValue>;
    seq: number;
    publishedAt: number;
  }> {
    const config = this.#config!;
    const activityId = `${config.iris.outbox}/${crypto.randomUUID()}`;
    const activity = buildPostActivity(input, config.iris, {
      activityId,
      objectId: `${activityId}/object`,
      published: new Date().toISOString(),
    });
    const publishedAt = Date.now();
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      activityId,
      JSON.stringify(activity),
      publishedAt,
    );

    const json_ = JSON.stringify(activity);
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) this.#enqueueDelivery(row.inbox, json_);
    }
    if (input.audience) {
      this.#deliverToAudience(input.audience, json_);
    }
    await this.#armAlarm();

    const seq = this.#sql
      .exec<{ seq: number }>(`SELECT seq FROM outbox WHERE id = ?`, activityId)
      .one().seq;
    return { activityId, activity, seq, publishedAt };
  }
```

Replace with:

```ts
  async #storePost(
    input: PostInput,
    opts: { skipDelivery?: boolean } = {},
  ): Promise<{
    activityId: string;
    activity: Record<string, JsonValue>;
    seq: number;
    publishedAt: number;
  }> {
    const config = this.#config!;
    const activityId = `${config.iris.outbox}/${crypto.randomUUID()}`;
    const published = isValidPublished(input.published)
      ? input.published
      : new Date().toISOString();
    const activity = buildPostActivity(input, config.iris, {
      activityId,
      objectId: `${activityId}/object`,
      published,
    });
    const publishedAt = Date.parse(published);
    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
      activityId,
      JSON.stringify(activity),
      publishedAt,
    );

    // Quiet-insert mode (#451, backfill): store the row and stop — no
    // follower fan-out, no community delivery, no alarm. `#clientPublish`
    // never sets this, so its live-posting behavior is unchanged.
    if (!opts.skipDelivery) {
      const json_ = JSON.stringify(activity);
      for (const row of this.#sql
        .exec<{
          inbox: string | null;
        }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
        .toArray()) {
        if (row.inbox) this.#enqueueDelivery(row.inbox, json_);
      }
      if (input.audience) {
        this.#deliverToAudience(input.audience, json_);
      }
      await this.#armAlarm();
    }

    const seq = this.#sql
      .exec<{ seq: number }>(`SELECT seq FROM outbox WHERE id = ?`, activityId)
      .one().seq;
    return { activityId, activity, seq, publishedAt };
  }
```

`#clientPublish` calls `this.#storePost(parsed.input)` with no second argument — `opts` defaults to `{}`, so `opts.skipDelivery` is `undefined` (falsy) and its behavior is unchanged. No edit needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub object.test -t "shaped post publish endpoint"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): quiet-insert and backdated published on the shaped-post publish path"
```

---

### Task 4: order the outbox `OrderedCollection` by `published_at`

**Files:**
- Modify: `packages/activitypub/src/object.ts`
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new (internal ordering change only).

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `packages/activitypub/src/object.test.ts`, placed immediately after the `describe("shaped post publish endpoint", ...)` block's closing `});`:

```ts
describe("outbox ordering by published_at (#451)", () => {
  it("orders the outbox OrderedCollection by published_at, not insertion order", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      // Insert the more-recently-published row first (lower seq) and the
      // backdated row second (higher seq), so a pure `seq DESC` order would
      // put the backdated row first — the wrong order relative to its
      // historical `published_at`.
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${iris.outbox}/recent`,
        JSON.stringify({ id: `${iris.outbox}/recent`, type: "Create" }),
        Date.parse("2024-01-01T00:00:00.000Z"),
      );
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${iris.outbox}/backfilled`,
        JSON.stringify({ id: `${iris.outbox}/backfilled`, type: "Create" }),
        Date.parse("2019-01-01T00:00:00.000Z"),
      );

      const res = await instance.fetch(
        new Request(`${iris.outbox}?page=1`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      const page = (await res.json()) as {
        orderedItems: Array<{ id: string }>;
      };
      expect(page.orderedItems.map((item) => item.id)).toEqual([
        `${iris.outbox}/recent`,
        `${iris.outbox}/backfilled`,
      ]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub object.test -t "outbox ordering by published_at"`
Expected: FAIL — `#pageItems` currently orders by `seq DESC`, so `/backfilled` (inserted second, higher `seq`) comes first.

- [ ] **Step 3: Implement**

In `packages/activitypub/src/object.ts`, find the outbox branch of `#pageItems`:

```ts
    if (kind === "outbox") {
      return this.#sql
        .exec<{ json: string }>(
          `SELECT json FROM outbox ORDER BY seq DESC LIMIT ? OFFSET ?`,
          pageSize,
          offset,
        )
        .toArray()
        .map((row) => JSON.parse(row.json) as JsonValue);
    }
```

Replace with:

```ts
    if (kind === "outbox") {
      return this.#sql
        .exec<{ json: string }>(
          `SELECT json FROM outbox ORDER BY published_at DESC, seq DESC LIMIT ? OFFSET ?`,
          pageSize,
          offset,
        )
        .toArray()
        .map((row) => JSON.parse(row.json) as JsonValue);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub object.test -t "outbox ordering by published_at"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "fix(activitypub): order the outbox collection by published_at"
```

---

### Task 5: front door — `?skipDelivery=1` query param translation

**Files:**
- Modify: `packages/activitypub/src/handler.ts`
- Test: `packages/activitypub/src/index.test.ts`

**Interfaces:**
- Consumes: `INTERNAL_HEADERS.skipDelivery` from Task 2; the DO-side `skipDelivery` handling from Tasks 2–3.
- Produces: nothing new — this is the last piece wiring the public HTTP surface to the already-tested DO behavior.

- [ ] **Step 1: Write the failing test**

Add this test to `packages/activitypub/src/index.test.ts`, inside `describe("publish endpoint", ...)`, right after the `it("requires the bearer token and publishes a Create to the outbox", ...)` test (before `it("rejects an oversized publish body with 413", ...)`):

```ts
  it("skipDelivery inserts into the outbox without queuing follower delivery", async () => {
    const config = makeConfig({ publishToken: "s3cret" });
    const handler = createActivityPub(config);
    const iris = deriveIris(config.baseUrl, config.actor.username);
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
    });

    const created = await handler(
      new Request(`${actorUrl(config)}/outbox?skipDelivery=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer s3cret",
          "content-type": "application/activity+json",
        },
        body: JSON.stringify({
          type: "Note",
          content: "backfilled post",
          published: "2019-03-01T12:00:00.000Z",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(created.status).toBe(201);
    const activity = (await created.json()) as Record<string, unknown>;
    expect(activity.published).toBe("2019-03-01T12:00:00.000Z");

    await runInDurableObject(stub, async (_instance, state) => {
      const outboxCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxCount).toBe(1);
      const deliveryCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(deliveryCount).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub index.test -t "skipDelivery"`
Expected: FAIL — the front door never forwards `INTERNAL_HEADERS.skipDelivery`, so the DO runs the normal delivery path and `deliveryCount` is `1`, not `0`.

- [ ] **Step 3: Implement**

In `packages/activitypub/src/handler.ts`, find the end of the owner-publish block:

```ts
      return forwardToDo(resolved, env, request.url, {
        method,
        body: forwardBody,
        extra: { [INTERNAL_HEADERS.publish]: "1" },
      });
    }
```

Replace with:

```ts
      const extra: Record<string, string> = {
        [INTERNAL_HEADERS.publish]: "1",
      };
      if (url.searchParams.get("skipDelivery") === "1") {
        extra[INTERNAL_HEADERS.skipDelivery] = "1";
      }
      return forwardToDo(resolved, env, request.url, {
        method,
        body: forwardBody,
        extra,
      });
    }
```

(`url` is already in scope — it's parsed once near the top of the returned handler: `const url = new URL(request.url);`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub index.test -t "skipDelivery"`
Expected: PASS

- [ ] **Step 5: Run the full `@dwk/activitypub` suite**

Run: `pnpm test --project @dwk/activitypub`
Expected: PASS (all tests, including Tasks 1–4's)

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/handler.ts packages/activitypub/src/index.test.ts
git commit -m "feat(activitypub): translate ?skipDelivery=1 into the DO quiet-insert header"
```

---

### Task 6: changeset, lint, typecheck, build

**Files:**
- Create: `.changeset/activitypub-outbox-backfill.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — this is the release-bookkeeping and CI-parity task that closes out the plan.

- [ ] **Step 1: Add the changeset**

Create `.changeset/activitypub-outbox-backfill.md`:

```markdown
---
"@dwk/activitypub": minor
---

Add backfill support to the outbox Durable Object (#451): `?skipDelivery=1`
on `POST <actor>/outbox` and `POST <actor>/publish` inserts the activity into
the outbox without follower fan-out, relationship routing, community
delivery, or arming the delivery alarm, and a caller-supplied `published`
(ISO-8601) is preserved instead of always being stamped to `now`. The outbox
`OrderedCollection` now orders by `published_at` instead of insertion order,
so a backfilled post sorts into its historical position.
```

- [ ] **Step 2: Run the full local CI gate for this package**

```bash
pnpm lint
pnpm format:check
pnpm --filter @dwk/activitypub typecheck
pnpm --filter @dwk/activitypub build
pnpm test --project @dwk/activitypub
```

Expected: all five pass. If `format:check` fails, run `pnpm format` and re-check; if it changed files outside this plan's scope, only stage the files this plan touched.

- [ ] **Step 3: Commit**

```bash
git add .changeset/activitypub-outbox-backfill.md
git commit -m "chore(activitypub): add changeset for outbox backfill support"
```
