# `@dwk/activitypub` inbound `Flag` (report) review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an `@dwk/activitypub` actor owner a way to see and dismiss inbound `Flag` (report) activities, which are currently silently dropped.

**Architecture:** Store inbound `Flag` activities in the existing per-actor Durable Object's `inbox` table (same `#storeInbox` path `Like`/`Dislike`/`Announce` already use, but never forwarded). Add two new `inbox` columns (`type`, `resolved_at`) so reports can be filtered and tombstoned. Expose them via a new bearer-gated, paginated `GET <actor>/reports` route (mirrors `/blocked` and `/follow_requests`). Let the owner resolve one via the existing `POST <actor>/outbox` seam with a new `Ignore(Flag)` activity (mirrors `Accept`/`Remove`).

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SQLite storage), Vitest (`cloudflare:test` — `runInDurableObject`).

## Global Constraints

- **Design doc:** `docs/superpowers/specs/2026-08-18-activitypub-flag-report-review-design.md` — the authoritative design for this plan; every task below implements a section of it.
- **TypeScript strict**, `import type` for type-only imports, prefix deliberately-unused vars with `_`.
- **No comments unless the WHY is non-obvious** — this codebase's existing comments (visible throughout `object.ts`/`handler.ts`) are the house style to match: explain a hidden constraint or a subtle invariant, never what the code obviously does.
- **Conventional commits:** `<type>(<scope>): <subject>` — every commit in this plan uses `feat(activitypub): ...` or `test(activitypub): ...`, lowercase, not capitalized, no period.
- **Changesets:** `commit: false` — the changeset file is added and committed manually (Task 4), never via `pnpm changeset`'s interactive prompt in an agentic context; write the file directly in the format `.changeset/*.md` files in this repo already use (see Task 4).
- Run `pnpm test --project @dwk/activitypub` (not a bare `pnpm test`) after every implementation step — this is a multi-project vitest workspace.
- Run `pnpm --filter @dwk/activitypub typecheck` before the final commit of each task — new columns/branches must type-check against `ActivityObject`/`JsonValue`.

---

### Task 1: Store inbound `Flag`, add `type`/`resolved_at` columns

**Files:**

- Modify: `packages/activitypub/src/object.ts:326-332` (schema migration block)
- Modify: `packages/activitypub/src/object.ts:1175-1210` (`#storeInbox`)
- Modify: `packages/activitypub/src/object.ts:613-696` (`#handleInbox`'s dispatch switch)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: existing `#storeInbox(activity, relay?)`, `#ensureColumn(table, column, type)`, `#sql` (the DO's `SqlStorage`), `ActivityObject` (from `./as2.js`).
- Produces: every stored `inbox` row now has a `type` column (the activity's own top-level AS2 `type`, e.g. `"Flag"`, `"Like"`) and a `resolved_at` column (`INTEGER`, `NULL` until resolved) — later tasks read both.

- [ ] **Step 1: Write the failing tests**

Add to `packages/activitypub/src/object.test.ts`, inside the existing `describe("inbox handling", ...)` block (near the other §7.1.2 forwarding tests, after the `"does not forward a reply that references no local object"` test):

```ts
it("stores an inbound Flag (report) without forwarding it, even when addressed to followers (#489)", async () => {
  const { username, iris, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
      REMOTE,
      `${REMOTE}/inbox`,
      1,
    );
    const res = await instance.fetch(
      inboxRequest(
        username,
        JSON.stringify({
          id: "https://remote.example/flags/1",
          type: "Flag",
          actor: REMOTE,
          object: [iris.id, "https://remote.example/notes/1"],
          content: "spam",
          to: [iris.followers],
        }),
      ),
    );
    expect(res.status).toBe(202);
    const row = state.storage.sql
      .exec<{ type: string | null; resolved_at: number | null }>(
        `SELECT type, resolved_at FROM inbox WHERE id = ?`,
        "https://remote.example/flags/1",
      )
      .one();
    expect(row.type).toBe("Flag");
    expect(row.resolved_at).toBeNull();
    // Reports are private: never forwarded, even though `to` names followers
    // (unlike a `Create`/`Like`/`Announce` addressed the same way).
    expect(counts(state, "delivery")).toBe(0);
  });
});

it("records the top-level activity type on every stored inbox row, not only Flag (#489)", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    const res = await instance.fetch(
      inboxRequest(
        username,
        JSON.stringify({
          id: "https://remote.example/likes/1",
          type: "Like",
          actor: REMOTE,
          object: "https://example.example/post/1",
        }),
      ),
    );
    expect(res.status).toBe(202);
    const row = state.storage.sql
      .exec<{ type: string | null }>(
        `SELECT type FROM inbox WHERE id = ?`,
        "https://remote.example/likes/1",
      )
      .one();
    expect(row.type).toBe("Like");
  });
});
```

`counts` and `inboxRequest` are existing helpers already defined earlier in this file (`counts` at the `Group`-moderation test section, `inboxRequest` near the top of the "Inbox activity handling" section) — no new imports needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub -t "Flag"`
Expected: FAIL — `type`/`resolved_at` are not real columns yet (`SqlStorage` throws on the `SELECT`), and `Flag` isn't stored at all yet (the `default` switch branch silently drops it, so the row wouldn't exist).

- [ ] **Step 3: Add the schema columns**

In `packages/activitypub/src/object.ts`, immediately after the existing `removed_at` migration line (currently line 332):

```ts
this.#ensureColumn("inbox", "removed_at", "INTEGER");
// The activity's own top-level AS2 `type` (#489) — distinct from
// `object_type`, which classifies the *embedded* object and is null for
// bare-IRI objects like most `Flag`s/`Like`s. Populated going forward by
// `#storeInbox`; no backfill needed, because no `Flag` was ever stored
// before this feature (it hit the `default` switch case and was
// dropped), so a NULL `type` on a pre-existing row can never
// misclassify it as an open report.
this.#ensureColumn("inbox", "type", "TEXT");
// Report resolution (#489): NULL means still open; a timestamp means the
// owner dismissed it via `Ignore` (see `#publish`). Mirrors `removed_at`'s
// tombstone pattern.
this.#ensureColumn("inbox", "resolved_at", "INTEGER");
```

- [ ] **Step 4: Populate `type` in `#storeInbox`**

In `packages/activitypub/src/object.ts`, `#storeInbox` currently reads:

```ts
const { objectType, audience } = classifyActivity(activity);
this.#sql.exec(
  `INSERT OR IGNORE INTO inbox
         (id, json, received_at, object_type, audience, relayed_by, verify_state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  id,
  JSON.stringify(activity),
  Date.now(),
  objectType ?? null,
  audience ?? relay?.audienceFallback ?? null,
  relay?.relayedBy ?? null,
  relay?.verifyState ?? null,
);
```

Change it to:

```ts
const { objectType, audience } = classifyActivity(activity);
const type = typeof activity.type === "string" ? activity.type : null;
this.#sql.exec(
  `INSERT OR IGNORE INTO inbox
         (id, json, received_at, object_type, audience, relayed_by, verify_state, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  id,
  JSON.stringify(activity),
  Date.now(),
  objectType ?? null,
  audience ?? relay?.audienceFallback ?? null,
  relay?.relayedBy ?? null,
  relay?.verifyState ?? null,
  type,
);
```

- [ ] **Step 5: Add the `Flag` dispatch case**

In `packages/activitypub/src/object.ts`, `#handleInbox`'s dispatch switch currently ends its `"Announce"` case with:

```ts
      case "Announce":
        await this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        // FEP-1b12: a followed Group relays member activities wrapped in its
        // own Announce — unwrap and store the inner activity too (§2.2).
        await this.#maybeUnwrapAnnounce(activity, config);
        break;
      default:
```

Insert a new case between `"Announce"` and `default`:

```ts
      case "Announce":
        await this.#storeInbox(activity);
        await this.#maybeForward(activity, firstSeen, config);
        // FEP-1b12: a followed Group relays member activities wrapped in its
        // own Announce — unwrap and store the inner activity too (§2.2).
        await this.#maybeUnwrapAnnounce(activity, config);
        break;
      case "Flag":
        // A report (#489). Stored like Like/Dislike/Announce, but
        // deliberately WITHOUT #maybeForward — a report must never fan out
        // to followers or anyone else, even if it happened to name the
        // followers collection as its audience.
        await this.#storeInbox(activity);
        break;
      default:
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub -t "Flag"`
Expected: PASS

- [ ] **Step 7: Run the full package test suite and typecheck**

Run: `pnpm test --project @dwk/activitypub`
Run: `pnpm --filter @dwk/activitypub typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): store inbound Flag activities without forwarding them

Inbound Flag (report) activities previously fell through the default
switch case and were silently dropped. Store them via the existing
#storeInbox path (like Like/Dislike/Announce), but never call
#maybeForward -- a report must never fan out to followers. Adds type
and resolved_at columns to inbox so a later change can list and
resolve open reports (#489)."
```

---

### Task 2: `GET <actor>/reports` — bearer-gated, paginated report listing

**Files:**

- Modify: `packages/activitypub/src/object.ts` (new `#listReports` method + `#route` wiring)
- Modify: `packages/activitypub/src/handler.ts` (new front-door route)
- Test: `packages/activitypub/src/object.test.ts`
- Test: `packages/activitypub/src/index.test.ts`

**Interfaces:**

- Consumes: Task 1's `inbox.type`/`inbox.resolved_at` columns; existing `#route`'s `iris`/`config`/`pathOf` machinery; `handler.ts`'s existing `resolved.publishToken`/`authorizedPublish`/`forwardToDo`/`emit` machinery.
- Produces: `GET <actor>/reports` — `200 { items: JsonValue[], total: number, page: number, pageSize: number }` (raw AS2 `Flag` JSON, newest first, open reports only) behind the owner's `publishToken`; `404` when disabled or on any non-`GET` verb; `401` on a bad/missing token.

- [ ] **Step 1: Write the failing DO-level test**

Add to `packages/activitypub/src/object.test.ts`, directly after the existing `"serves pending follow requests only behind the owner marker (#487)"` test:

```ts
it("serves open reports only behind the owner marker, paginated, newest first (#489)", async () => {
  const { username, iris, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    const flag = (
      id: string,
      receivedAt: number,
      resolvedAt: number | null,
    ) => {
      state.storage.sql.exec(
        `INSERT INTO inbox (id, json, received_at, type, resolved_at) VALUES (?, ?, ?, ?, ?)`,
        id,
        JSON.stringify({
          id,
          type: "Flag",
          actor: REMOTE,
          object: iris.id,
          content: "spam",
        }),
        receivedAt,
        "Flag",
        resolvedAt,
      );
    };
    flag("https://remote.example/flags/1", 1, null);
    flag("https://remote.example/flags/2", 2, 999); // already resolved
    flag("https://remote.example/flags/3", 3, null);
    // An unrelated stored activity must never appear in /reports.
    state.storage.sql.exec(
      `INSERT INTO inbox (id, json, received_at, type) VALUES (?, ?, ?, ?)`,
      "https://remote.example/likes/1",
      JSON.stringify({
        id: "https://remote.example/likes/1",
        type: "Like",
        actor: REMOTE,
        object: iris.id,
      }),
      4,
      "Like",
    );

    const headers: Record<string, string> = {
      [INTERNAL_HEADERS.config]: cfgHeader(username),
    };
    const unmarked = await instance.fetch(
      new Request(`${iris.id}/reports`, { headers }),
    );
    expect(unmarked.status).toBe(404);

    const owner = { ...headers, [INTERNAL_HEADERS.publish]: "1" };
    const listed = await instance.fetch(
      new Request(`${iris.id}/reports`, { headers: owner }),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      items: { id: string; type: string }[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.id)).toEqual([
      "https://remote.example/flags/3",
      "https://remote.example/flags/1",
    ]);
    expect(body.page).toBe(1);

    // Anything but an authorized GET is 404, never 405 — same reasoning as
    // `/blocked`/`/follow_requests`.
    const written = await instance.fetch(
      new Request(`${iris.id}/reports`, { method: "DELETE", headers: owner }),
    );
    expect(written.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "serves open reports"`
Expected: FAIL — `GET <actor>/reports` isn't routed yet, so every request 404s (including the "owner" one, which the test expects to be `200`).

- [ ] **Step 3: Add `#listReports` to `object.ts`**

Add this method directly after `#listBlocked` (which currently ends right before `#count`):

```ts
  /**
   * Open (unresolved) inbound reports, newest first, for the owner-facing
   * `GET <actor>/reports` route (#489). Unlike `/blocked`/`/follow_requests`
   * — unpaged, because a personal blocklist/approval-queue stays small —
   * this is page/pageSize-paginated like `#listInbox`: reports arrive from
   * arbitrary peers, and a hostile one could flood them. Returns the raw AS2
   * `Flag` JSON (matching `#listInbox`'s shape) so the owner sees the
   * reporter, the reported target, and the free-text reason in full.
   */
  #listReports(request: Request): Response {
    const config = this.#config!;
    const url = new URL(request.url);
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
    );
    const requestedPageSize = Number.parseInt(
      url.searchParams.get("pageSize") ?? "",
      10,
    );
    const pageSize =
      Number.isFinite(requestedPageSize) && requestedPageSize > 0
        ? Math.min(requestedPageSize, config.pageSize)
        : config.pageSize;
    const offset = (page - 1) * pageSize;

    const total = this.#sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbox WHERE type = 'Flag' AND resolved_at IS NULL`,
      )
      .one().n;
    const items = this.#sql
      .exec<{ json: string }>(
        `SELECT json FROM inbox WHERE type = 'Flag' AND resolved_at IS NULL
           ORDER BY seq DESC LIMIT ? OFFSET ?`,
        pageSize,
        offset,
      )
      .toArray()
      .map((row) => JSON.parse(row.json) as JsonValue);
    return json(200, { items, total, page, pageSize } as JsonValue);
  }

```

- [ ] **Step 4: Wire the route in `#route`**

In `packages/activitypub/src/object.ts`'s `#route`, the `follow_requests` block currently ends with:

```ts
    if (path === `${pathOf(iris.id)}/follow_requests`) {
      if (
        method !== "GET" ||
        request.headers.get(INTERNAL_HEADERS.publish) !== "1"
      ) {
        return text(404, "Not Found");
      }
      return this.#listPendingFollowers();
    }
    if (path === pathOf(iris.inbox)) {
```

Insert a new block between them:

```ts
    if (path === `${pathOf(iris.id)}/follow_requests`) {
      if (
        method !== "GET" ||
        request.headers.get(INTERNAL_HEADERS.publish) !== "1"
      ) {
        return text(404, "Not Found");
      }
      return this.#listPendingFollowers();
    }
    // Owner report read (#489): bearer-gated, like `/blocked` and
    // `/follow_requests` above. Same 404-not-405 rule.
    if (path === `${pathOf(iris.id)}/reports`) {
      if (
        method !== "GET" ||
        request.headers.get(INTERNAL_HEADERS.publish) !== "1"
      ) {
        return text(404, "Not Found");
      }
      return this.#listReports(request);
    }
    if (path === pathOf(iris.inbox)) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "serves open reports"`
Expected: PASS

- [ ] **Step 6: Write the failing front-door tests**

Add to `packages/activitypub/src/index.test.ts`, directly after the existing `"keeps the follow-requests list behind the owner token (#487)"` test (still inside the same enclosing `describe` block):

```ts
it("lists open reports behind the owner token, paginated (#489)", async () => {
  const config = makeConfig({ publishToken: "s3cret" });
  const handler = createActivityPub(config);
  const iris = deriveIris(config.baseUrl, config.actor.username);
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO inbox (id, json, received_at, type) VALUES (?, ?, ?, ?)`,
      "https://remote.example/flags/1",
      JSON.stringify({
        id: "https://remote.example/flags/1",
        type: "Flag",
        actor: REMOTE,
        object: iris.id,
        content: "spam",
      }),
      1,
      "Flag",
    );
  });

  const res = await handler(
    new Request(`${actorUrl(config)}/reports`, {
      headers: { authorization: "Bearer s3cret" },
    }),
    testEnv,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[]; total: number };
  expect(body.total).toBe(1);
  expect(body.items[0]?.id).toBe("https://remote.example/flags/1");
});

it("keeps the reports list behind the owner token (#489)", async () => {
  const config = makeConfig({ publishToken: "s3cret" });
  const handler = createActivityPub(config);

  const anonymous = await handler(
    new Request(`${actorUrl(config)}/reports`),
    testEnv,
    ctx,
  );
  expect(anonymous.status).toBe(401);

  const wrongToken = await handler(
    new Request(`${actorUrl(config)}/reports`, {
      headers: { authorization: "Bearer wrong" },
    }),
    testEnv,
    ctx,
  );
  expect(wrongToken.status).toBe(401);

  const written = await handler(
    new Request(`${actorUrl(config)}/reports`, {
      method: "DELETE",
      headers: { authorization: "Bearer s3cret" },
    }),
    testEnv,
    ctx,
  );
  expect(written.status).toBe(404);

  const openConfig = makeConfig();
  const noToken = createActivityPub(openConfig);
  const disabled = await noToken(
    new Request(`${actorUrl(openConfig)}/reports`, {
      headers: { authorization: "Bearer s3cret" },
    }),
    testEnv,
    ctx,
  );
  expect(disabled.status).toBe(404);
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub -t "reports behind the owner token"`
Expected: FAIL — `handler.ts` doesn't route `/reports` yet, so every case (including the expected-`200` one) currently 404s.

- [ ] **Step 8: Wire the front-door route in `handler.ts`**

In `packages/activitypub/src/handler.ts`, add a new path constant alongside the existing ones (currently lines 249-250):

```ts
const blockedPath = `${actorPath}/blocked`;
const followRequestsPath = `${actorPath}/follow_requests`;
const reportsPath = `${actorPath}/reports`;
```

Then, immediately after the existing `follow_requests` block (which currently ends right before the `--- Collection reads ---` comment), add:

```ts
// --- Owner report read (#489) -------------------------------------------
// Bearer-gated, paginated (unlike /blocked and /follow_requests, which
// stay unpaged because those lists are owner-curated and small — reports
// arrive from arbitrary peers and could be flooded). Same 404-not-405
// asymmetry on the wrong verb as every other private owner route here.
if (path === reportsPath && method === "GET") {
  if (!resolved.publishToken) {
    emit(resolved, "warn", ActivityPubLogEvent.PublishRejected, {
      reason: "disabled",
    });
    return text(404, "Not Found");
  }
  if (!(await authorizedPublish(request, resolved.publishToken))) {
    emit(resolved, "warn", ActivityPubLogEvent.PublishRejected, {
      reason: "unauthorized",
    });
    return text(401, "Unauthorized");
  }
  return forwardToDo(resolved, env, request.url, {
    method,
    extra: { [INTERNAL_HEADERS.publish]: "1" },
  });
}

// --- Collection reads (authoritative; routed to the DO) -----------------
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub -t "reports"`
Expected: PASS (all `/reports`-named tests across both files).

- [ ] **Step 10: Run the full package test suite and typecheck**

Run: `pnpm test --project @dwk/activitypub`
Run: `pnpm --filter @dwk/activitypub typecheck`
Expected: PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/handler.ts packages/activitypub/src/object.test.ts packages/activitypub/src/index.test.ts
git commit -m "feat(activitypub): add bearer-gated paginated GET <actor>/reports

Owner-facing read of open inbound Flag reports, mirroring /blocked
and /follow_requests' bearer-token gate but page/pageSize-paginated
like /outbox -- reports arrive from arbitrary peers and could be
flooded, unlike those two owner-curated lists (#489)."
```

---

### Task 3: Owner `Ignore(Flag)` — resolve/dismiss a report

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`#publish` new branch, `#asOutboxActivity` allowlist)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: Task 1's `inbox.type`/`inbox.resolved_at`; Task 2's `#listReports` (used only to assert end-to-end behavior in the test, not a code dependency); existing `objectId` (from `./as2.js`, already imported), `#publish`, `#asOutboxActivity`.
- Produces: `POST <actor>/outbox` with `{ "type": "Ignore", "object": "<flag-activity-id>" }` (bearer `publishToken`-gated, same as `Accept`/`Remove`) → `202` with the normalized `Ignore` activity; sets `inbox.resolved_at` on the matching `type = 'Flag'` row; never written to the outbox; never delivered to anyone.

- [ ] **Step 1: Write the failing tests**

Add to `packages/activitypub/src/object.test.ts`, directly after the existing owner `Remove` tests (the ones using `outboxRequest(username, JSON.stringify({ type: "Remove", ... }), true)`), inside the same `describe("publish endpoint", ...)` block:

```ts
it("Ignore(Flag): resolves an open report, drops it from /reports, and is never delivered or stored to the outbox (#489)", async () => {
  const { username, iris, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO inbox (id, json, received_at, type) VALUES (?, ?, ?, ?)`,
      "https://remote.example/flags/1",
      JSON.stringify({
        id: "https://remote.example/flags/1",
        type: "Flag",
        actor: REMOTE,
        object: iris.id,
        content: "spam",
      }),
      1,
      "Flag",
    );

    const res = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({
          type: "Ignore",
          object: "https://remote.example/flags/1",
        }),
        true,
      ),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { type: string; object: string };
    // Passed through as a real activity, not wrapped in a synthetic Create
    // (a regression here would show up as body.type === "Create").
    expect(body.type).toBe("Ignore");
    expect(body.object).toBe("https://remote.example/flags/1");

    const row = state.storage.sql
      .exec<{ resolved_at: number | null }>(
        `SELECT resolved_at FROM inbox WHERE id = ?`,
        "https://remote.example/flags/1",
      )
      .one();
    expect(row.resolved_at).not.toBeNull();

    expect(counts(state, "outbox")).toBe(0);
    expect(counts(state, "delivery")).toBe(0);

    const owner = {
      [INTERNAL_HEADERS.config]: cfgHeader(username),
      [INTERNAL_HEADERS.publish]: "1",
    };
    const listed = await instance.fetch(
      new Request(`${iris.id}/reports`, { headers: owner }),
    );
    const listBody = (await listed.json()) as { total: number };
    expect(listBody.total).toBe(0);
  });
});

it("Ignore(Flag) on an unknown or already-resolved id is a silent no-op (#489)", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    const res = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({
          type: "Ignore",
          object: "https://remote.example/flags/does-not-exist",
        }),
        true,
      ),
    );
    expect(res.status).toBe(202);
    // Nothing was ever stored for this id -- confirms the UPDATE affected
    // zero rows without creating one or raising an error.
    expect(counts(state, "inbox")).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub -t "Ignore(Flag)"`
Expected: FAIL — `Ignore` isn't a recognized branch in `#publish` yet, so it falls through to ordinary outbox storage (the first test's `counts(state, "outbox")` would be `1`, not `0`, and `resolved_at` would still be `NULL`); the second test would likely still pass (harmless no-op today) but run it alongside the first to confirm the suite is red for the right reason.

- [ ] **Step 3: Add `"Ignore"` to `#asOutboxActivity`'s allowlist**

In `packages/activitypub/src/object.ts`, `#asOutboxActivity`'s `isActivity` array currently ends with:

```ts
        // Owner admin (#473): confirm a pending follower / Group moderation —
        // same reasoning as Block/Reject above.
        "Accept",
        "Remove",
      ].includes(input.type);
```

Change to:

```ts
        // Owner admin (#473): confirm a pending follower / Group moderation —
        // same reasoning as Block/Reject above.
        "Accept",
        "Remove",
        // Owner report review (#489): resolve/dismiss a Flag — same
        // reasoning again.
        "Ignore",
      ].includes(input.type);
```

- [ ] **Step 4: Add the `Ignore` branch to `#publish`**

In `packages/activitypub/src/object.ts`, `#publish` currently has the `Remove` branch immediately followed by the "Blind addressing" comment:

```ts
        await this.#applyModerationRemove(activity, config, !skipDelivery);
        return json(202, activity as JsonValue);
      }
    }

    // Blind addressing (#496): `bto`/`bcc` recipients are delivered to
```

Insert a new branch between the closing `}` of the `Remove` block and the "Blind addressing" comment:

```ts
        await this.#applyModerationRemove(activity, config, !skipDelivery);
        return json(202, activity as JsonValue);
      }
    }

    // Owner report resolution (#489): dismiss an open Flag. Own top-level
    // branch, like Remove above -- not folded into isFollowerControlActivity,
    // since Ignore(Flag) never delivers to anyone (purely local review
    // state, like the ban half of Remove). Not Group-gated: reports apply to
    // Person actors too. An id with no matching open Flag row is a silent
    // no-op (UPDATE affects zero rows) -- the same "unroutable → dropped"
    // convention Accept/Reject/Block already use for a normal race (e.g. the
    // report was already resolved through another client).
    if (activity.type === "Ignore") {
      const target = objectId(activity.object);
      if (target) {
        this.#sql.exec(
          `UPDATE inbox SET resolved_at = COALESCE(resolved_at, ?)
             WHERE id = ? AND type = 'Flag'`,
          Date.now(),
          target,
        );
      }
      return json(202, activity as JsonValue);
    }

    // Blind addressing (#496): `bto`/`bcc` recipients are delivered to
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub -t "Ignore(Flag)"`
Expected: PASS

- [ ] **Step 6: Run the full package test suite and typecheck**

Run: `pnpm test --project @dwk/activitypub`
Run: `pnpm --filter @dwk/activitypub typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): add owner Ignore(Flag) to resolve/dismiss a report

Rides the existing POST <actor>/outbox seam, exactly like Accept and
Remove: { type: 'Ignore', object: '<flag-activity-id>' } sets
resolved_at on the matching inbox row, dropping it from
GET <actor>/reports. Never written to the outbox or delivered to
anyone -- purely local review state (#489)."
```

---

### Task 4: Spec, package docs, and changeset

**Files:**

- Modify: `spec/packages/activitypub.md`
- Modify: `packages/activitypub/CLAUDE.md`
- Create: `.changeset/activitypub-flag-report-review.md`

**Interfaces:**

- Consumes: nothing (documentation-only task).
- Produces: nothing consumed by other tasks — this is the terminal documentation task.

- [ ] **Step 1: Update `spec/packages/activitypub.md`**

Insert a new bullet immediately after the existing `GET <actor>/follow_requests` bullet (which currently ends with `"... without standing up a separate OAuth flow just to see who is pending."`, right before the `### Blind-addressed restricted delivery` heading):

```markdown
- **Owner report review (#489).** Inbound `Flag` activities (a peer's report
  against an actor or content) are stored via the same `#storeInbox` path as
  `Like`/`Dislike`/`Announce` — but never forwarded (§7.1.2 forwarding is
  skipped for `Flag`; a report must never fan out to followers, even when
  addressed to them). **`GET <actor>/reports`** returns open (unresolved)
  reports behind the same bearer token as `/blocked`/`/follow_requests` —
  unlike those two, it is page/pageSize-paginated like `/outbox`, since
  reports arrive from arbitrary peers rather than being owner-curated. Each
  item is the raw AS2 `Flag` activity (reporter, reported target, and the
  free-text `content` reason). The owner resolves/dismisses a report the
  same way as `Accept`/`Remove` — `POST <actor>/outbox` with
  `{ "type": "Ignore", "object": "<flag-activity-id>" }` — which is never
  written to the outbox or delivered to anyone; it only clears the report
  from `/reports`. An unknown or already-resolved id is a silent no-op,
  matching `Accept`'s convention for a similar race.
```

- [ ] **Step 2: Update `packages/activitypub/CLAUDE.md`**

In the "Key constraints" list, extend the existing "Owner follower control (#447)" bullet's final sentence (which currently ends `"... so an owner client doesn't need OAuth just to see who is pending."`) by appending:

```markdown
`GET <actor>/reports` (#489) lists open inbound `Flag` reports the same
way (paginated, unlike `/blocked`/`/follow_requests`, since reports arrive
from arbitrary peers); the owner resolves one via `POST <actor>/outbox`
with `{ "type": "Ignore", "object": "<flag-id>" }`, mirroring `Accept`/
`Remove`.
```

- [ ] **Step 3: Add the changeset**

Create `.changeset/activitypub-flag-report-review.md`:

```markdown
---
"@dwk/activitypub": minor
---

Store inbound `Flag` (report) activities instead of silently dropping
them, add a bearer-gated paginated `GET <actor>/reports` to list open
reports, and let the owner resolve one via `POST <actor>/outbox` with
`{ "type": "Ignore", "object": "<flag-id>" }` (#489).
```

- [ ] **Step 4: Run the full package test suite once more (docs-only task, but confirms nothing was left broken)**

Run: `pnpm test --project @dwk/activitypub`
Run: `pnpm --filter @dwk/activitypub typecheck`
Run: `pnpm format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spec/packages/activitypub.md packages/activitypub/CLAUDE.md .changeset/activitypub-flag-report-review.md
git commit -m "docs(activitypub): document Flag/reports/Ignore review flow (#489)"
```

---

## Self-review notes

- **Spec coverage:** design §1 (store) → Task 1; §2 (schema) → Task 1; §3
  (`GET /reports`) → Task 2; §4 (`Ignore` resolve) → Task 3; §5
  (`#asOutboxActivity` fix) → Task 3 Step 3. All five design sections have a
  task.
- **No placeholders:** every step above shows the exact code to write, not a
  description of it.
- **Type consistency:** `#listReports(request: Request): Response` matches
  its call site in `#route` (`return this.#listReports(request);`); the
  `Ignore` branch's `objectId`/`json`/`ActivityObject` usages match the
  existing imports already present in `object.ts` (no new imports needed
  anywhere in this plan).
