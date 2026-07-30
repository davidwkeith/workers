# ActivityPub owner-admin endpoints (Accept + Group moderation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner of an `@dwk/activitypub` actor confirm a pending follower and moderate their `Group` (ban a member / un-announce a post) from their own client, and let real off-the-shelf Mastodon clients manage pending follows through `@dwk/mastodon-api`.

**Architecture:** Two owner-published AS2 activity types (`Accept`, `Remove`) are special-cased in the DO's existing `POST <actor>/outbox` seam (`packages/activitypub/src/object.ts`), reusing the wire shapes already defined for the equivalent federated activities. `@dwk/mastodon-api` gains a `follow_requests` write surface (`GET`/`POST .../authorize`/`POST .../reject`) that internally calls the same DO seam through `@dwk/activitypub`'s adapter — no duplicated logic, two front doors over one code path.

**Tech Stack:** TypeScript, Cloudflare Durable Objects (SQLite storage), Vitest with `cloudflare:test` (`runInDurableObject`), pnpm workspace.

## Global Constraints

- ESM-only, strict TypeScript, `import type` for type-only imports, prefix deliberately-unused vars with `_` (root `CLAUDE.md`).
- `packages/activitypub`: Cloudflare specifics confined to `@dwk/store`/endpoint packages; `KV MUST NEVER be used for authz` (n/a here, no KV involved); DPoP-everywhere except the documented plain-bearer exception in `@dwk/mastodon-api` (spec/non-functional-requirements.md).
- `packages/mastodon-api`: opaque hashed bearer tokens, isolated to this package's routes; scopes echoed, never narrowed; write routes gated by `config.allowWrites` (package `CLAUDE.md`, spec/packages/mastodon-api.md § Write surface).
- Commit messages / PR title: Conventional Commits, `<type>(<scope>): <subject>`, scope = package name minus `@dwk/` prefix, comma-separated for several packages (root `CLAUDE.md`).
- Design spec: `docs/superpowers/specs/2026-07-30-activitypub-owner-admin-accept-moderation-design.md` — the authoritative source for every decision below; consult it for the "why" behind any task.

---

## Task 1: `#asOutboxActivity` — recognize `Accept` and `Remove` as real activities

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`#asOutboxActivity`, currently ~line 1642-1696)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: from this task on, `#publish` receives an owner-supplied `{type: "Accept", ...}` or `{type: "Remove", ...}` unchanged (actor/id normalized, not wrapped in a `Create`). Every later task in this plan depends on this.

Without this fix, `#asOutboxActivity` treats `Accept`/`Remove` as "bare objects" and wraps them in a synthetic `Create`, so none of the later branches (Tasks 4 and 5) would ever see a top-level `Accept`/`Remove` — the wrapped body would just get published as ordinary content instead.

- [ ] **Step 1: Write the failing test**

Add near the existing `#asOutboxActivity`-adjacent publish tests in `packages/activitypub/src/object.test.ts` (the `describe("publish endpoint", ...)` block, after the `"publishes a pre-wrapped activity unchanged at the top level"` test):

```ts
it("passes Accept and Remove through as real activities, not wrapped in a Create", async () => {
  const { username, iris, stub } = freshUser();
  await runInDurableObject(stub, async (instance) => {
    const acceptRes = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({ type: "Accept", object: REMOTE }),
        true,
      ),
    );
    const accept = (await acceptRes.json()) as Record<string, unknown>;
    expect(accept.type).toBe("Accept");
    expect(accept.actor).toBe(iris.id);

    const removeRes = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({
          type: "Remove",
          object: REMOTE,
          target: iris.followers,
        }),
        true,
      ),
    );
    const remove = (await removeRes.json()) as Record<string, unknown>;
    expect(remove.type).toBe("Remove");
    expect(remove.actor).toBe(iris.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "passes Accept and Remove through"`
Expected: FAIL — the response bodies come back `{type: "Create", ...}` (both get wrapped) rather than `{type: "Accept"/"Remove", ...}`.

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`, in `#asOutboxActivity`, extend the `isActivity` list:

```ts
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
    // Follower control (#447): these are activities in their own right —
    // wrapping one in a `Create` would publish "the owner created a Block
    // object" instead of performing the block.
    "Block",
    "Reject",
    // Owner admin (#473): confirm a pending follower / Group moderation —
    // same reasoning as Block/Reject above.
    "Accept",
    "Remove",
  ].includes(input.type);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "passes Accept and Remove through"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "fix(activitypub): recognize owner Accept/Remove as real outbox activities"
```

---

## Task 2: `followers.accepted_at` column, with one-time migration backfill

**Files:**

- Modify: `packages/activitypub/src/object.ts` (constructor / `#ensureColumn`, currently ~line 318-348)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `followers.accepted_at INTEGER` (nullable). `#ensureColumn` now returns `boolean` (whether it just added the column) — every existing call site ignores the return value already, so this is source-compatible. Task 3 and Task 4 write to this column; Task 6 reads it.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block in `packages/activitypub/src/object.test.ts` (anywhere top-level, e.g. right after the `seedFollower` helper's `describe("owner follower control (#447)", ...)` block closes):

```ts
describe("followers.accepted_at migration (#473)", () => {
  it("backfills accepted_at = added_at for pre-existing rows on first migration, and never re-runs on a later construction", async () => {
    const { username, stub } = freshUser();

    // First construction: insert a row directly, bypassing #onFollow, so it
    // predates the accepted_at column exactly like a real pre-migration row.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1234,
      );
    });

    // Trigger a fresh construction against the same stub id: the column
    // exists already after the first runInDurableObject call above (SQLite
    // storage persists across calls to the same stub), so this second call
    // exercises the constructor's #ensureColumn path once the column is
    // already present.
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ accepted_at: number | null }>(
          `SELECT accepted_at FROM followers WHERE actor = ?`,
          REMOTE,
        )
        .one();
      expect(row.accepted_at).toBe(1234);

      // Simulate a genuinely-still-pending row created after migration.
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, ?, ?, NULL)`,
        "https://remote.example/users/pending-carol",
        null,
        5678,
      );
    });

    // A third construction must NOT re-run the backfill: the genuinely-NULL
    // row from the previous block must stay NULL.
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ accepted_at: number | null }>(
          `SELECT accepted_at FROM followers WHERE actor = ?`,
          "https://remote.example/users/pending-carol",
        )
        .one();
      expect(row.accepted_at).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "backfills accepted_at"`
Expected: FAIL — `accepted_at` column does not exist yet (SQL error) or, once you stub the column in without the boolean-gated backfill, the first assertion fails (`row.accepted_at` is `null`, not `1234`).

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`, change `#ensureColumn`'s signature and return:

```ts
  /**
   * Add a nullable column if this object predates it (additive migration).
   * Checks `PRAGMA table_info` first (matching `@dwk/store`'s pattern) rather
   * than attempting the `ALTER TABLE` and pattern-matching the error string
   * for "duplicate column" — a substring match would silently swallow an
   * unrelated SQLite error (e.g. a disk-full write failure) that happens to
   * mention "duplicate column" in its own message, or miss a legitimate
   * duplicate-column error phrased differently by a future SQLite version.
   * Returns whether the column was just added, so a caller can run a
   * one-time backfill exactly once (see the `followers.accepted_at` call
   * site below) rather than on every constructor invocation.
   */
  #ensureColumn(table: string, column: string, type: string): boolean {
    const columns = this.#sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (columns.some((c) => c.name === column)) return false;
    this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  }
```

Then, at the end of the existing migration block in the constructor (after the `this.#ensureColumn("following", "shared_inbox", "TEXT");` line):

```ts
this.#ensureColumn("following", "shared_inbox", "TEXT");
// Owner-admin follow confirmation (#473): NULL means still awaiting the
// owner's `Accept`; non-NULL (the timestamp) means confirmed — either
// auto-accepted at insert time (#onFollow) or owner-triggered later
// (#routeFollowerControl's Accept branch). Every pre-existing row
// predates this column and has no other stored signal of whether it was
// genuinely still pending at migration time; backfilling all of them to
// "already settled" (their `added_at`) avoids surfacing years of
// ordinary auto-accepted followers as false "pending" requests. This
// must run only the one time the column is actually added — never on
// every cold start, or it would silently re-confirm every currently-
// pending follower on every restart.
if (this.#ensureColumn("followers", "accepted_at", "INTEGER")) {
  this.#sql.exec(
    `UPDATE followers SET accepted_at = added_at WHERE accepted_at IS NULL`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "backfills accepted_at"`
Expected: PASS

- [ ] **Step 5: Run the full object.ts test suite to check nothing else broke**

Run: `pnpm test --project @dwk/activitypub object.test`
Expected: PASS (all existing tests still green — this is an additive, backward-compatible column)

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): add followers.accepted_at with one-time migration backfill"
```

---

## Task 3: `#onFollow` sets `accepted_at`

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`#onFollow`, currently ~line 662-727)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: `followers.accepted_at` column (Task 2).
- Produces: a new follower row has `accepted_at = <insert time>` when auto-accepted (`!manuallyApprovesFollowers`), `accepted_at = NULL` when awaiting manual approval. Task 6's `__client/follow_requests` list depends on this being correct.

- [ ] **Step 1: Write the failing test**

Add to the existing FEP-1b12 / follow-handling area of `packages/activitypub/src/object.test.ts` (near the other `#onFollow`-exercising tests — search for `"records the inbound Follow's id"` and add alongside it):

```ts
it("sets accepted_at immediately on auto-accept, leaves it NULL under manual approval, and never un-sets it on a re-Follow", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    // Auto-accept (default config): accepted_at is set immediately.
    await instance.fetch(
      signedInboxRequest(
        username,
        {
          id: `${REMOTE}/activities/follow-auto`,
          type: "Follow",
          actor: REMOTE,
          object: deriveIris(BASE, username).id,
        },
        REMOTE,
      ),
    );
    const auto = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        REMOTE,
      )
      .one();
    expect(auto.accepted_at).not.toBeNull();

    // Manual approval, a different follower: accepted_at stays NULL.
    const PENDING = "https://remote.example/users/pending";
    await instance.fetch(
      signedInboxRequest(
        username,
        {
          id: `${PENDING}/activities/follow-1`,
          type: "Follow",
          actor: PENDING,
          object: deriveIris(BASE, username).id,
        },
        PENDING,
        { manuallyApprovesFollowers: true },
      ),
    );
    const pending = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        PENDING,
      )
      .one();
    expect(pending.accepted_at).toBeNull();

    // Manually mark it accepted (simulating Task 4's Accept branch, not yet
    // implemented), then re-Follow: accepted_at must not be reset to NULL.
    state.storage.sql.exec(
      `UPDATE followers SET accepted_at = ? WHERE actor = ?`,
      9999,
      PENDING,
    );
    await instance.fetch(
      signedInboxRequest(
        username,
        {
          id: `${PENDING}/activities/follow-2`,
          type: "Follow",
          actor: PENDING,
          object: deriveIris(BASE, username).id,
        },
        PENDING,
        { manuallyApprovesFollowers: true },
      ),
    );
    const reFollowed = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        PENDING,
      )
      .one();
    expect(reFollowed.accepted_at).toBe(9999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "sets accepted_at immediately"`
Expected: FAIL — `auto.accepted_at` is `null` (column is never written by `#onFollow` yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`, in `#onFollow`, change the insert:

```ts
// Record the follower first (inbox filled in on the auto-accept path), so a
// manually-approved actor never triggers an outbound actor fetch here.
const now = Date.now();
const alreadyFollowing =
  this.#sql.exec(`SELECT 1 FROM followers WHERE actor = ?`, follower).toArray()
    .length > 0;
// The `Follow`'s own IRI is kept so a later owner `Reject` can name the
// activity it rejects (#447). Only a real `Follow` contributes one — the
// FEP-1b12 membership `Join` synonym routes here too, and labelling its id
// as a `Follow` id would misname it on the wire. A re-`Follow` refreshes a
// NULL id without disturbing `added_at` or an already-resolved `inbox`.
const followId =
  activity.type === "Follow" && typeof activity.id === "string"
    ? activity.id
    : null;
// Owner-admin follow confirmation (#473): auto-accept sets accepted_at
// immediately; manual approval leaves it NULL until the owner's later
// Accept action (#routeFollowerControl). A re-Follow must never un-set an
// already-recorded acceptance, hence the COALESCE in ON CONFLICT below —
// same "refresh without disturbing settled state" shape as follow_id's.
const acceptedAt = config.manuallyApprovesFollowers ? null : now;
this.#sql.exec(
  `INSERT INTO followers (actor, inbox, added_at, follow_id, accepted_at)
         VALUES (?, NULL, ?, ?, ?)
         ON CONFLICT(actor) DO UPDATE
           SET follow_id = COALESCE(excluded.follow_id, followers.follow_id),
               accepted_at = COALESCE(followers.accepted_at, excluded.accepted_at)`,
  follower,
  now,
  followId,
  acceptedAt,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "sets accepted_at immediately"`
Expected: PASS

- [ ] **Step 5: Run the full object.ts test suite**

Run: `pnpm test --project @dwk/activitypub object.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): record follower accepted_at on auto-accept vs manual approval"
```

---

## Task 4: Owner `Accept` — confirm a pending follower

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`isFollowerControlActivity` ~line 136, `#rejectTarget` ~line 1465, `#routeFollowerControl` ~line 1361, `#publish` calls `isFollowerControlActivity`/`#routeFollowerControl` ~line 1256)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: `#singleFollowTarget` (renamed from `#rejectTarget`, same signature: `(activity: Record<string, JsonValue>) => string | undefined`); `followers.accepted_at` (Tasks 2-3).
- Produces: an owner `POST <actor>/outbox` with `{type: "Accept", object: <follower-iri-or-follow-id-or-embedded-Follow>}` delivers a canonical `Accept(Follow)` to that follower's inbox alone and sets `accepted_at`. This is the exact code path Task 10 (mastodon-api adapter) reuses for "authorize".

- [ ] **Step 1: Write the failing tests**

Add to the `describe("owner follower control (#447)", ...)` block in `packages/activitypub/src/object.test.ts` (alongside the existing `Reject`/`Block` tests):

```ts
it("Accept: confirms a pending follower and delivers Accept(Follow) to them alone, setting accepted_at", async () => {
  const { username, stub } = freshUser();
  const iris = deriveIris(BASE, username);
  await runInDurableObject(stub, async (instance, state) => {
    seedFollower(state);
    state.storage.sql.exec(
      `UPDATE followers SET accepted_at = NULL WHERE actor = ?`,
      REMOTE,
    );
    // A second follower must not see the Accept.
    seedFollower(state, "https://other.example/users/carol", null);

    const res = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({ type: "Accept", object: REMOTE }),
        true,
      ),
    );
    expect(res.status).toBe(202);

    const row = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        REMOTE,
      )
      .one();
    expect(row.accepted_at).not.toBeNull();

    // Targeted at the confirmed follower only — never the follower fan-out.
    expect(counts(state, "delivery")).toBe(0);
    const queued = targetedDeliveries(state);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.actor).toBe(REMOTE);
    expect(queued[0]?.activity.type).toBe("Accept");
    expect(queued[0]?.activity.actor).toBe(iris.id);
    expect(queued[0]?.activity.object).toEqual({
      id: `${REMOTE}/activities/follow-1`,
      type: "Follow",
      actor: REMOTE,
      object: iris.id,
    });

    // Never lands in the publicly served outbox.
    expect(counts(state, "outbox")).toBe(0);
  });
});

it("Accept: accepts the actor-IRI shorthand and the stored Follow id, same as Reject", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    seedFollower(state);
    const byActor = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({ type: "Accept", object: REMOTE }),
        true,
      ),
    );
    expect(byActor.status).toBe(202);
    expect(
      ((await byActor.json()) as { object: Record<string, unknown> }).object
        .actor,
    ).toBe(REMOTE);
  });
});

it("Accept: no-ops (still 202, no queued delivery) for an actor with no followers row", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    const res = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({ type: "Accept", object: REMOTE }),
        true,
      ),
    );
    expect(res.status).toBe(202);
    expect(targetedDeliveries(state)).toHaveLength(0);
    const armed = await state.storage.getAlarm();
    expect(armed).toBeNull();
  });
});

it("Accept: with ?skipDelivery=1, still marks accepted_at but queues no delivery", async () => {
  const { username, stub } = freshUser();
  await runInDurableObject(stub, async (instance, state) => {
    seedFollower(state);
    state.storage.sql.exec(
      `UPDATE followers SET accepted_at = NULL WHERE actor = ?`,
      REMOTE,
    );
    const res = await instance.fetch(
      outboxRequest(
        username,
        JSON.stringify({ type: "Accept", object: REMOTE }),
        true,
        true,
      ),
    );
    expect(res.status).toBe(202);
    expect(targetedDeliveries(state)).toHaveLength(0);
    const row = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        REMOTE,
      )
      .one();
    expect(row.accepted_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "Accept:"`
Expected: FAIL — `Accept` is not yet in `isFollowerControlActivity`, so it falls through to ordinary outbox storage + full follower broadcast; the first test's `expect(counts(state, "outbox")).toBe(0)` and the targeted-delivery assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`:

**3a. Extend `isFollowerControlActivity`** (~line 124-144):

```ts
/**
 * Whether an owner-published activity is a **single-target relationship**
 * activity (#447, #473) — one aimed at a single actor's relationship with
 * this one, rather than content for the follower set: `Reject` (of a
 * `Follow`), `Block`, `Undo(Block)`, and `Accept` (confirming a pending
 * follower).
 *
 * Every `Reject`/`Accept` qualifies, not only one carrying a well-formed
 * `Follow`: the failure this guards against is a control activity leaking
 * into the follower fan-out, so an unroutable one is claimed here and
 * dropped rather than broadcast. `Reject`/`Accept` of an event `Join` is not
 * a case this actor can produce — manual `Join` approval is out of scope
 * for v1 (spec §"Events & RSVPs").
 */
function isFollowerControlActivity(
  activity: Record<string, JsonValue>,
): boolean {
  if (
    activity.type === "Block" ||
    activity.type === "Reject" ||
    activity.type === "Accept"
  ) {
    return true;
  }
  return (
    activity.type === "Undo" &&
    objectType(activity.object as JsonValue) === "Block"
  );
}
```

**3b. Rename `#rejectTarget` → `#singleFollowTarget`** (~line 1465-1477), no logic change:

```ts
  /**
   * The follower a single-target `Reject`/`Accept` names. Canonically its
   * `object` is the `Follow` being rejected/accepted (target = that
   * activity's `actor`). As a shorthand the owner may pass a bare IRI, which
   * is read as the stored `Follow`'s id when it matches one we recorded and
   * as the follower's actor IRI otherwise — the two readings a client can
   * reasonably take of "reject/accept this follow".
   *
   * That last fallback deliberately does **not** require a matching
   * `followers` row for `Reject` — a `Reject` is most needed exactly when
   * our state and the peer's disagree — see `#routeFollowerControl`'s
   * `Reject` branch for that looseness; `Accept` layers its own stricter
   * "row must exist" check on top, since confirming a follow that was never
   * recorded doesn't make sense.
   */
  #singleFollowTarget(activity: Record<string, JsonValue>): string | undefined {
    const object = activity.object;
    if (typeof object === "string") {
      const row = this.#sql
        .exec<{
          actor: string;
        }>(`SELECT actor FROM followers WHERE follow_id = ?`, object)
        .toArray()[0];
      return row?.actor ?? object;
    }
    if (objectType(object) !== "Follow") return undefined;
    return actorIri((object as Record<string, JsonValue>).actor);
  }
```

Update its one existing call site inside `#routeFollowerControl`'s `Reject` branch (`this.#rejectTarget(activity)` → `this.#singleFollowTarget(activity)`).

**3c. Add the `Accept` branch to `#routeFollowerControl`** (~line 1361), as a new `if` before the existing `if (activity.type === "Reject")` block:

```ts
  #routeFollowerControl(
    activity: Record<string, JsonValue>,
    deliver: boolean,
  ): boolean {
    const iris = this.#config!.iris;
    const now = Date.now();
    // These never reach the outbox, so the outbox-namespaced id
    // `#asOutboxActivity` minted would dereference to a 404 on the peer's
    // side. Re-mint as a fragment of the actor IRI — the same convention the
    // other non-stored activities this package authors use (`#accepts/…`,
    // `#undos/…`).
    activity.id = `${iris.id}#${(activity.type as string).toLowerCase()}s/${crypto.randomUUID()}`;

    if (activity.type === "Accept") {
      const follower = this.#singleFollowTarget(activity);
      if (!follower) return false;
      const row = this.#sql
        .exec<{
          follow_id: string | null;
        }>(`SELECT follow_id FROM followers WHERE actor = ?`, follower)
        .toArray()[0];
      // Unlike Reject's drift-repair looseness: confirming a follow that was
      // never recorded doesn't make sense, so an unknown actor no-ops.
      if (!row) return false;
      // Local state always applies, independent of `deliver`/skipDelivery,
      // which only gates the outbound notification below — same rule every
      // other branch in this method follows.
      this.#sql.exec(
        `UPDATE followers SET accepted_at = COALESCE(accepted_at, ?) WHERE actor = ?`,
        now,
        follower,
      );
      activity.object = {
        ...(row.follow_id ? { id: row.follow_id } : {}),
        type: "Follow",
        actor: follower,
        object: iris.id,
      };
      addressPrivately(activity, follower);
      if (!deliver || !isSafeTarget(follower)) return false;
      this.#enqueuePendingDelivery(follower, JSON.stringify(activity));
      return true;
    }

    if (activity.type === "Reject") {
      const follower = this.#singleFollowTarget(activity);
```

(The rest of the `Reject` branch, and the `Block`/`Undo(Block)` branches after it, are unchanged — only the `#rejectTarget` → `#singleFollowTarget` rename inside it, per 3b.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "Accept:"`
Expected: PASS

- [ ] **Step 5: Run the full object.ts test suite**

Run: `pnpm test --project @dwk/activitypub object.test`
Expected: PASS (in particular, the existing `Reject`/`Block` tests must still pass unmodified — confirms the rename didn't change behavior)

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): owner Accept confirms a pending follower via POST <actor>/outbox"
```

---

## Task 5: Owner `Remove` — ban a member / un-announce a post

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`#onModerationRemove` ~line 886, `#removeAnnouncedPost` ~line 919, `#publish` ~line 1225)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: `objectId`, `objectType` (existing, from `as2.ts`).
- Produces: `#applyModerationRemove(activity, config, deliver)` — the shared core both the inbound moderator path and the new owner path call. `#removeAnnouncedPost` gains a `deliver: boolean = true` parameter.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("publish endpoint", ...)` area of `packages/activitypub/src/object.test.ts` (near the `outboxRequest` helper's other consumers):

```ts
describe("owner Remove: Group moderation (#473)", () => {
  it("bans a member without requiring the owner's actor IRI in config.moderators", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        new Request(iris.outbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username, {
              actorType: "Group",
              moderators: [], // deliberately empty
            }),
            [INTERNAL_HEADERS.publish]: "1",
          },
          body: JSON.stringify({
            type: "Remove",
            object: REMOTE,
            target: iris.followers,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(counts(state, "followers")).toBe(0);
      const banned = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM banned WHERE actor = ?`,
          REMOTE,
        )
        .one().n;
      expect(banned).toBe(1);
    });
  });

  it("un-announces a post, still fanning out Undo(Announce)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        AUTHOR,
        `${AUTHOR}/inbox`,
        1,
      );
      const announceId = `${iris.outbox}/announce-1`;
      const innerId = `${AUTHOR}/activities/post-3`;
      const announce = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: announceId,
        type: "Announce",
        actor: iris.id,
        object: {
          id: innerId,
          type: "Create",
          actor: AUTHOR,
          object: { id: `${innerId}/object`, type: "Note" },
        },
      };
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        announceId,
        JSON.stringify(announce),
        1,
      );
      state.storage.sql.exec(
        `INSERT INTO inbox (id, json, received_at) VALUES (?, ?, ?)`,
        innerId,
        JSON.stringify(announce.object),
        1,
      );

      const res = await instance.fetch(
        new Request(iris.outbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username, {
              actorType: "Group",
            }),
            [INTERNAL_HEADERS.publish]: "1",
          },
          body: JSON.stringify({
            type: "Remove",
            object: announceId,
            target: iris.outbox,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(counts(state, "outbox")).toBe(0);
      const removedAt = state.storage.sql
        .exec<{ removed_at: number | null }>(
          `SELECT removed_at FROM inbox WHERE id = ?`,
          innerId,
        )
        .one().removed_at;
      expect(removedAt).not.toBeNull();
      expect(counts(state, "delivery")).toBe(1);
    });
  });

  it("un-announcing with ?skipDelivery=1 still tombstones locally but queues no Undo(Announce)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        AUTHOR,
        `${AUTHOR}/inbox`,
        1,
      );
      const announceId = `${iris.outbox}/announce-2`;
      const innerId = `${AUTHOR}/activities/post-4`;
      const announce = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: announceId,
        type: "Announce",
        actor: iris.id,
        object: { id: innerId, type: "Create", actor: AUTHOR },
      };
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        announceId,
        JSON.stringify(announce),
        1,
      );

      const res = await instance.fetch(
        new Request(`${iris.outbox}?skipDelivery=1`, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username, {
              actorType: "Group",
            }),
            [INTERNAL_HEADERS.publish]: "1",
            [INTERNAL_HEADERS.skipDelivery]: "1",
          },
          body: JSON.stringify({
            type: "Remove",
            object: announceId,
            target: iris.outbox,
          }),
        }),
      );
      expect(res.status).toBe(202);
      expect(counts(state, "outbox")).toBe(0);
      expect(counts(state, "delivery")).toBe(0);
    });
  });

  it("400s on a non-Group actor", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(iris.outbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username), // default actorType: "Person"
            [INTERNAL_HEADERS.publish]: "1",
          },
          body: JSON.stringify({
            type: "Remove",
            object: REMOTE,
            target: iris.followers,
          }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "owner Remove: Group moderation"`
Expected: FAIL — `Remove` is not yet special-cased in `#publish`, so it gets stored to the outbox and broadcast; the `400` test fails too (no such branch exists).

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`:

**5a. Extract `#applyModerationRemove`** from `#onModerationRemove` (~line 886-910). Replace the whole method with:

```ts
  /**
   * `Group` moderation (#376, #473): either bans a member (`target` names our
   * `followers` collection, `object` names the member) or un-announces a
   * member post (`target` names our `outbox`, `object` names the `Announce`
   * id we authored for it). Ignored for a `Person` actor. Shared by the
   * inbound moderator-signed path (`#onModerationRemove`, which checks
   * `config.moderators` before calling this) and the owner-publish path
   * (`#publish`'s `Remove` branch, which skips that check — the owner is
   * implicitly the top moderator of their own actor). `deliver` gates only
   * the un-announce fan-out (`?skipDelivery=1`); the ban branch has no
   * delivery to suppress either way.
   */
  async #applyModerationRemove(
    activity: ActivityObject,
    config: ForwardedConfig,
    deliver: boolean,
  ): Promise<void> {
    if (config.actorType !== "Group") return;
    const object = objectId(activity.object);
    if (!object) return;
    const target = objectId(activity.target);

    if (target === config.iris.followers) {
      this.#sql.exec(`DELETE FROM followers WHERE actor = ?`, object);
      this.#sql.exec(
        `INSERT INTO banned (actor, banned_at) VALUES (?, ?)
           ON CONFLICT(actor) DO UPDATE SET banned_at = excluded.banned_at`,
        object,
        Date.now(),
      );
      return;
    }
    if (target === config.iris.outbox) {
      await this.#removeAnnouncedPost(object, config, deliver);
    }
  }

  /**
   * `Group` moderation (#376): a signed `Remove` from a listed
   * `config.moderators` actor invokes {@link #applyModerationRemove}.
   * Ignored when the (HTTP-signature-verified — see the `signer ===
   * activity.actor` check in {@link #handleInbox}) requester is not a
   * configured moderator. Inbound moderation always delivers — there is no
   * backfill concept for it.
   */
  async #onModerationRemove(
    activity: ActivityObject,
    config: ForwardedConfig,
  ): Promise<void> {
    const moderator = actorIri(activity.actor);
    if (!moderator || !config.moderators.includes(moderator)) return;
    await this.#applyModerationRemove(activity, config, /* deliver */ true);
  }
```

**5b. Give `#removeAnnouncedPost` a `deliver` parameter** (~line 919-972):

```ts
  /**
   * Un-announce a member post (#376 remove-post): delete the `Announce` we
   * authored for it from our outbox, tombstone the relayed inbox copy so
   * reads stop surfacing it — both always applied — and, unless `deliver` is
   * `false` (`?skipDelivery=1` on an owner-triggered Remove, #473), fan out a
   * self-signed `Undo(Announce)` to the membership so their servers retract
   * the boost too — the same `followers`-inbox fan-out
   * {@link #maybeAnnounceMemberPost} uses.
   */
  async #removeAnnouncedPost(
    announceId: string,
    config: ForwardedConfig,
    deliver: boolean = true,
  ): Promise<void> {
    const row = this.#sql
      .exec<{
        json: string;
      }>(`SELECT json FROM outbox WHERE id = ?`, announceId)
      .toArray()[0];
    if (!row) return;
    let announce: ActivityObject;
    try {
      announce = JSON.parse(row.json) as ActivityObject;
    } catch {
      return;
    }
    if (
      announce.type !== "Announce" ||
      actorIri(announce.actor) !== config.iris.id
    ) {
      return;
    }
    this.#sql.exec(`DELETE FROM outbox WHERE id = ?`, announceId);
    const innerId = objectId(announce.object);
    if (innerId) {
      this.#sql.exec(
        `UPDATE inbox SET removed_at = ? WHERE id = ?`,
        Date.now(),
        innerId,
      );
    }
    if (!deliver) return;
    const undo: Record<string, JsonValue> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${config.iris.id}#undos/${crypto.randomUUID()}`,
      type: "Undo",
      actor: config.iris.id,
      to: [PUBLIC_AUDIENCE],
      cc: [config.iris.followers],
      object: announce as JsonValue,
    };
    const body = JSON.stringify(undo);
    let any = false;
    for (const row of this.#sql
      .exec<{
        inbox: string | null;
      }>(`SELECT inbox FROM followers WHERE inbox IS NOT NULL`)
      .toArray()) {
      if (row.inbox) {
        this.#enqueueDelivery(row.inbox, body);
        any = true;
      }
    }
    if (any) await this.#armAlarm();
  }
```

**5c. Add the `Remove` branch to `#publish`** (~line 1225), immediately after the existing `isFollowerControlActivity` block and before `this.#sql.exec(\`INSERT OR IGNORE INTO outbox ...\`)`:

```ts
    if (isFollowerControlActivity(activity)) {
      const delivered = this.#routeFollowerControl(activity, !skipDelivery);
      if (delivered) await this.#armAlarm();
      return json(202, activity as JsonValue);
    }

    // Owner Group moderation (#473): ban a member / un-announce a post. Not
    // added to isFollowerControlActivity — its delivery model differs (ban
    // has no delivery at all; un-announce's fan-out is a broadcast to the
    // whole membership, not a single target). No config.moderators check
    // here: bearer publishToken auth at the front door is authorization
    // enough, and the owner is implicitly the top moderator of their own
    // actor — this succeeds even when moderators is empty or doesn't list
    // the owner's own actor IRI.
    if (activity.type === "Remove") {
      if (config.actorType !== "Group") {
        return text(400, "`Remove` moderation requires a Group actor");
      }
      await this.#applyModerationRemove(activity, config, !skipDelivery);
      return json(202, activity as JsonValue);
    }

    this.#sql.exec(
      `INSERT OR IGNORE INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "owner Remove: Group moderation"`
Expected: PASS

- [ ] **Step 5: Run the full object.ts test suite**

Run: `pnpm test --project @dwk/activitypub object.test`
Expected: PASS — in particular the existing inbound moderator-`Remove` tests (`"un-announces a member post via a moderator-signed Remove..."` and its ban-side sibling) must still pass unmodified, confirming the extraction preserved inbound semantics.

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): owner Remove bans a member or un-announces a post via POST <actor>/outbox"
```

---

## Task 6: Internal DO route `__client/follow_requests`

**Files:**

- Modify: `packages/activitypub/src/object.ts` (`#route` ~line 374-416, new `#listFollowRequests` method)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**

- Consumes: `followers.accepted_at` (Tasks 2-3), `json()` helper (existing).
- Produces: `GET <actor>/__client/follow_requests` (internal-header-gated) → `{items: [{actor, added_at}], total}`. Task 10 (mastodon-api adapter) consumes this.

- [ ] **Step 1: Write the failing test**

Add near the other `__client/*`/`__following` route tests in `packages/activitypub/src/object.test.ts` (search for `"__following"` to find that block and add alongside it):

```ts
describe("__client/follow_requests (#473)", () => {
  function followRequestsRequest(username: string, internal = true): Request {
    const iris = deriveIris(BASE, username);
    const headers: Record<string, string> = {
      [INTERNAL_HEADERS.config]: cfgHeader(username),
    };
    if (internal) headers[INTERNAL_HEADERS.internal] = "1";
    return new Request(`${iris.id}/__client/follow_requests`, { headers });
  }

  it("404s without the internal header", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(followRequestsRequest(username, false));
      expect(res.status).toBe(404);
    });
  });

  it("lists only accepted_at IS NULL rows, oldest first", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, NULL, ?, NULL)`,
        "https://remote.example/users/newer-pending",
        20,
      );
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, NULL, ?, NULL)`,
        "https://remote.example/users/older-pending",
        10,
      );
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, ?, ?, ?)`,
        "https://remote.example/users/already-confirmed",
        "https://remote.example/users/already-confirmed/inbox",
        5,
        999,
      );

      const res = await instance.fetch(followRequestsRequest(username));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { actor: string; added_at: number }[];
        total: number;
      };
      expect(body.total).toBe(2);
      expect(body.items.map((i) => i.actor)).toEqual([
        "https://remote.example/users/older-pending",
        "https://remote.example/users/newer-pending",
      ]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "__client/follow_requests"`
Expected: FAIL — the route doesn't exist yet, so both requests fall through to the generic `404` (the first test happens to pass by coincidence; the second fails since the route 404s instead of returning the list).

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/object.ts`, in `#route` (~line 411-416), add after the existing `__following` block:

```ts
if (path === `${pathOf(iris.id)}/__following`) {
  if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
    return text(404, "not found");
  }
  return this.#listFollowing(request);
}
// Owner-only pending-follower listing (internal, like `__following`):
// backs @dwk/mastodon-api's GET /api/v1/follow_requests (#473).
if (path === `${pathOf(iris.id)}/__client/follow_requests`) {
  if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
    return text(404, "not found");
  }
  return this.#listFollowRequests();
}
```

Add the new method near `#listBlocked` (same file):

```ts
  /**
   * Pending follow requests (#473): followers awaiting the owner's `Accept`.
   * Unpaged flat JSON, like `#listBlocked` — this list is small, and capping
   * it would silently hide requests from the only view of them there is.
   */
  #listFollowRequests(): Response {
    const items = this.#sql
      .exec<{
        actor: string;
        added_at: number;
      }>(
        `SELECT actor, added_at FROM followers WHERE accepted_at IS NULL ORDER BY added_at ASC`,
      )
      .toArray();
    return json(200, { items, total: items.length } as unknown as JsonValue);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "__client/follow_requests"`
Expected: PASS

- [ ] **Step 5: Run the full object.ts test suite**

Run: `pnpm test --project @dwk/activitypub object.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): internal __client/follow_requests route lists pending followers"
```

---

## Task 7: `@dwk/mastodon-api` — `MastodonBackend` gains `followRequests`/`respondToFollowRequest`

**Files:**

- Modify: `packages/mastodon-api/src/backend.ts`
- Test: none (a plain-data interface addition; exercised by Tasks 9 and 11's tests)

**Interfaces:**

- Consumes: nothing.
- Produces: `BackendFollowRequest {actor, addedAt}`; `MastodonBackend.followRequests?(): Promise<readonly BackendFollowRequest[]>`; `MastodonBackend.respondToFollowRequest?(actor: string, action: "authorize" | "reject"): Promise<void>`. Task 9 consumes both; Task 10 implements both.

This is a type-only addition (both members optional), so no test is required for this task in isolation — it's a compile-time contract. `pnpm --filter @dwk/mastodon-api typecheck` is this task's verification.

- [ ] **Step 1: Add the interface members**

In `packages/mastodon-api/src/backend.ts`, add after `BackendPublishInput`:

```ts
/** A pending follow request (#473) — a `followers` row awaiting the owner's `Accept`. */
export interface BackendFollowRequest {
  readonly actor: string;
  readonly addedAt: number;
}
```

Then add two new optional members to `MastodonBackend`, after `publishStatus?`:

```ts
  /**
   * Pending follow requests, oldest first (#473). Optional: absent backend ⇒
   * `GET /api/v1/follow_requests` answers `200 []`, matching every other
   * degrade-gracefully optional member here.
   */
  followRequests?(): Promise<readonly BackendFollowRequest[]>;
  /**
   * Authorize or reject a pending follow request (#473). Optional and
   * `allowWrites`-gated like `publishStatus` — absent backend or
   * `allowWrites` off ⇒ both write routes answer `404`.
   */
  respondToFollowRequest?(
    actor: string,
    action: "authorize" | "reject",
  ): Promise<void>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dwk/mastodon-api typecheck`
Expected: PASS (no consumers yet, so nothing can be broken — this just confirms the new syntax is valid TypeScript)

- [ ] **Step 3: Commit**

```bash
git add packages/mastodon-api/src/backend.ts
git commit -m "feat(mastodon-api): add followRequests/respondToFollowRequest to MastodonBackend"
```

---

## Task 8: `@dwk/mastodon-api` — `relationshipEntity`

**Files:**

- Modify: `packages/mastodon-api/src/entities.ts`
- Test: `packages/mastodon-api/src/entities.test.ts`

**Interfaces:**

- Consumes: `encodeRemoteAccountId` (existing, same file).
- Produces: `relationshipEntity(actorIri: string, opts: {followedBy: boolean}): Record<string, unknown>`. Task 9 consumes this.

- [ ] **Step 1: Write the failing test**

Add to `packages/mastodon-api/src/entities.test.ts` (append a new `describe` block):

```ts
describe("relationshipEntity", () => {
  it("builds a Relationship keyed by the reversible remote-account id", () => {
    const actor = "https://remote.example/users/alice";
    const entity = relationshipEntity(actor, { followedBy: true });
    expect(entity.id).toBe(encodeRemoteAccountId(actor));
    expect(entity.following).toBe(false);
    expect(entity.followed_by).toBe(true);
    expect(entity.requested).toBe(false);
    expect(entity.blocking).toBe(false);
  });

  it("reflects followedBy: false for a rejected request", () => {
    const actor = "https://remote.example/users/bob";
    const entity = relationshipEntity(actor, { followedBy: false });
    expect(entity.followed_by).toBe(false);
  });
});
```

Add the needed imports at the top of `entities.test.ts` (extend the existing import from `./entities.js` and `encodeRemoteAccountId` if not already imported — check the file's current import list first and only add what's missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api -t "relationshipEntity"`
Expected: FAIL — `relationshipEntity` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/mastodon-api/src/entities.ts`, add after `remoteAccountEntity`:

```ts
/**
 * A Mastodon `Relationship` entity (#473), returned by the
 * `follow_requests` authorize/reject write routes. Every boolean beyond
 * `followed_by` is a fixed, honest default: this deployment tracks none of
 * muting/blocking/endorsement state per remote actor beyond what's already
 * modeled elsewhere (blocklist, bans), and a stale `true` here would mislead
 * a client more than an honest `false`.
 */
export function relationshipEntity(
  actorIri: string,
  opts: { readonly followedBy: boolean },
): Record<string, unknown> {
  return {
    id: encodeRemoteAccountId(actorIri),
    following: false,
    showing_reblogs: true,
    notifying: false,
    followed_by: opts.followedBy,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    domain_blocking: false,
    endorsed: false,
    note: "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api -t "relationshipEntity"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/entities.ts packages/mastodon-api/src/entities.test.ts
git commit -m "feat(mastodon-api): add relationshipEntity for the follow_requests write surface"
```

---

## Task 9: `@dwk/mastodon-api` — `follow_requests` route handlers, wired into the router

**Files:**

- Create: `packages/mastodon-api/src/follow-requests.ts`
- Create: `packages/mastodon-api/src/follow-requests.test.ts`
- Modify: `packages/mastodon-api/src/stubs.ts` (remove the now-superseded `follow_requests` stub entry)
- Modify: `packages/mastodon-api/src/handler.ts` (register the three new routes)
- Test: `packages/mastodon-api/src/stubs.test.ts` (update if it enumerates `STUB_ROUTES` by path/count)

**Interfaces:**

- Consumes: `MastodonBackend.followRequests?`/`.respondToFollowRequest?` (Task 7), `relationshipEntity` (Task 8), `remoteAccountEntity`/`decodeRemoteAccountId` (existing `entities.ts`), `authenticateBearer`/`tokenHasScope` (existing `auth.ts`), `accountRequired`/`insufficientScope`/`invalidToken`/`recordNotFound` (existing `errors.ts`), `RouteContext` (existing `handler.ts`).
- Produces: `handleFollowRequests(ctx: RouteContext): Promise<Response>`; `handleFollowRequestRespond(ctx: RouteContext, id: string, action: "authorize" | "reject"): Promise<Response>`, both live-routed. Task 10 (adapter) is what makes these return real data instead of test-double `MastodonBackend`s.

- [ ] **Step 1: Write the failing tests**

Create `packages/mastodon-api/src/follow-requests.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { api, registerApp, resetDb, testConfig } from "./test-harness.js";
import type { BackendFollowRequest, MastodonBackend } from "./backend.js";
import { encodeRemoteAccountId } from "./entities.js";

const REMOTE = "https://remote.example/users/alice";

function readBackend(
  rows: readonly BackendFollowRequest[] = [],
): MastodonBackend {
  return {
    account: async () => ({
      counts: { followers: 0, following: 0, statuses: 0 },
    }),
    timeline: async () => ({ entries: [] }),
    notifications: async () => ({ entries: [] }),
    entry: async () => null,
    followRequests: async () => rows,
  };
}

function writeBackend(
  rows: readonly BackendFollowRequest[] = [],
): MastodonBackend & {
  readonly responses: { actor: string; action: "authorize" | "reject" }[];
} {
  const responses: { actor: string; action: "authorize" | "reject" }[] = [];
  return {
    ...readBackend(rows),
    responses,
    respondToFollowRequest: async (actor, action) => {
      responses.push({ actor, action });
    },
  };
}

/** Mint a bearer token whose grant carries exactly `scopes`. */
async function tokenWithScopes(scopes: string): Promise<string> {
  const app = await registerApp({ scopes });
  const authorize = new URL("https://owner.example/oauth/authorize");
  authorize.searchParams.set("client_id", app.client_id);
  authorize.searchParams.set("redirect_uri", "app://oauth-callback");
  authorize.searchParams.set("response_type", "code");
  const redirect = await api()(new Request(authorize.toString()));
  const code = new URL(redirect.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const res = await api()(
    new Request("https://owner.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code: code ?? "",
      }),
    }),
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

describe("GET /api/v1/follow_requests", () => {
  it("200s an empty array with no backend method", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, backend: readBackend() };
    delete (cfg.backend as Partial<MastodonBackend>).followRequests;
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("maps pending rows through remoteAccountEntity", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = {
      ...testConfig,
      backend: readBackend([{ actor: REMOTE, addedAt: 123 }]),
    };
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as { id: string }[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(encodeRemoteAccountId(REMOTE));
  });

  it("401s without a bearer token", async () => {
    await resetDb();
    const cfg = { ...testConfig, backend: readBackend() };
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests"),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/follow_requests/:id/authorize|reject", () => {
  it("404s when writes are not enabled", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, backend: writeBackend() }; // allowWrites defaults false
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("404s when writes are enabled but the backend cannot respond", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: readBackend() };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("403s a read-only token", async () => {
    await resetDb();
    const token = await tokenWithScopes("read");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("404s an undecodable id", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const res = await api(cfg)(
      new Request(
        "https://owner.example/api/v1/follow_requests/not-a-valid-id/authorize",
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("authorizes: calls the backend and returns a Relationship with followed_by:true", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend = writeBackend();
    const cfg = { ...testConfig, allowWrites: true, backend };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(200);
    expect(backend.responses).toEqual([{ actor: REMOTE, action: "authorize" }]);
    const relationship = (await res.json()) as { followed_by: boolean };
    expect(relationship.followed_by).toBe(true);
  });

  it("rejects: calls the backend and returns a Relationship with followed_by:false", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend = writeBackend();
    const cfg = { ...testConfig, allowWrites: true, backend };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/reject`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(200);
    expect(backend.responses).toEqual([{ actor: REMOTE, action: "reject" }]);
    const relationship = (await res.json()) as { followed_by: boolean };
    expect(relationship.followed_by).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api follow-requests`
Expected: FAIL — `./follow-requests.js` doesn't exist yet (import error).

- [ ] **Step 3: Write the implementation**

Create `packages/mastodon-api/src/follow-requests.ts`:

```ts
/**
 * `GET /api/v1/follow_requests`, `POST /api/v1/follow_requests/:id/authorize`,
 * `POST /api/v1/follow_requests/:id/reject` (#473) — the real, well-known
 * signature Mastodon clients (Tusky, Ivory, Elk) use to manage pending
 * follows. The list is a read (no `allowWrites` gate, matching
 * `handleNotifications`); the two write routes follow the exact
 * `config.allowWrites` + `write` scope pattern `statuses-write.ts` already
 * established for `POST /api/v1/statuses`.
 *
 * @see spec/packages/mastodon-api.md § Write surface
 */

import { authenticateBearer, tokenHasScope } from "./auth.js";
import {
  decodeRemoteAccountId,
  relationshipEntity,
  remoteAccountEntity,
} from "./entities.js";
import {
  accountRequired,
  insufficientScope,
  invalidToken,
  recordNotFound,
} from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

/** `GET /api/v1/follow_requests`. */
export async function handleFollowRequests(
  ctx: RouteContext,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend?.followRequests) return Response.json([]);

  const rows = await ctx.config.backend.followRequests();
  const accounts = await Promise.all(
    rows.map(async (row) => {
      const profile = ctx.config.backend?.actorProfile
        ? await ctx.config.backend.actorProfile(row.actor)
        : null;
      return remoteAccountEntity(row.actor, profile);
    }),
  );
  return Response.json(accounts);
}

/** Shared by both write routes; `action` is baked in by the caller. */
export async function handleFollowRequestRespond(
  ctx: RouteContext,
  id: string,
  action: "authorize" | "reject",
): Promise<Response> {
  if (!ctx.config.allowWrites || !ctx.config.backend?.respondToFollowRequest) {
    return recordNotFound();
  }
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!tokenHasScope(token.scope, "write:follows")) {
    return insufficientScope();
  }
  const actorIri = decodeRemoteAccountId(id);
  if (!actorIri) return recordNotFound();

  await ctx.config.backend.respondToFollowRequest(actorIri, action);
  return Response.json(
    relationshipEntity(actorIri, { followedBy: action === "authorize" }),
  );
}
```

- [ ] **Step 4: Remove the now-superseded static stub**

In `packages/mastodon-api/src/stubs.ts`, delete this line from `STUB_ROUTES` (a real route now shadows it — leaving it in would make the last-registered entry in the `ROUTES` `Map` win unpredictably depending on spread order, so it must go, not just be overridden):

```ts
  { path: "/api/v1/follow_requests", auth: true, body: [] },
```

Update the comment above `STUB_ROUTES` if it enumerates routes by name (check the file — if the comment just says "the v1 roster", no change needed beyond the deleted line).

- [ ] **Step 5: Register the new routes**

In `packages/mastodon-api/src/handler.ts`:

Add the import, alongside the other feature-module imports:

```ts
import {
  handleFollowRequestRespond,
  handleFollowRequests,
} from "./follow-requests.js";
```

Add to `ROUTES` (after the `["GET /api/v1/notifications", handleNotifications],` entry):

```ts
    ["GET /api/v1/follow_requests", handleFollowRequests],
```

Add to `DYNAMIC_ROUTES` (after the existing `/^\/api\/v1\/accounts\/([^/]+)\/(?:followers|following|featured_tags)$/` entry):

```ts
  [
    "POST",
    /^\/api\/v1\/follow_requests\/([^/]+)\/authorize$/,
    (ctx, id) => handleFollowRequestRespond(ctx, id, "authorize"),
  ],
  [
    "POST",
    /^\/api\/v1\/follow_requests\/([^/]+)\/reject$/,
    (ctx, id) => handleFollowRequestRespond(ctx, id, "reject"),
  ],
```

- [ ] **Step 6: Run the follow-requests tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api follow-requests`
Expected: PASS

- [ ] **Step 7: Run the full mastodon-api test suite (stubs.test.ts in particular)**

Run: `pnpm test --project @dwk/mastodon-api`
Expected: PASS. If `stubs.test.ts` enumerates `STUB_ROUTES` by path/count, update its expectations to drop `/api/v1/follow_requests` (read the test file first — only touch what actually asserts on the removed entry).

- [ ] **Step 8: Commit**

```bash
git add packages/mastodon-api/src/follow-requests.ts packages/mastodon-api/src/follow-requests.test.ts packages/mastodon-api/src/stubs.ts packages/mastodon-api/src/handler.ts packages/mastodon-api/src/stubs.test.ts
git commit -m "feat(mastodon-api): route follow_requests list/authorize/reject, replacing the empty stub"
```

---

## Task 10: `@dwk/activitypub` adapter — implement `followRequests`/`respondToFollowRequest`

**Files:**

- Modify: `packages/activitypub/src/mastodon-api.ts` (`buildMastodonBackend`)
- Test: `packages/activitypub/src/mastodon-api.test.ts`

**Interfaces:**

- Consumes: `__client/follow_requests` (Task 6), the owner-`Accept`/`Reject`-via-`/outbox` path (Task 4 and the pre-existing #447 `Reject`), `BackendFollowRequest`/`MastodonBackend` (Task 7).
- Produces: a real, working `MastodonBackend` for `@dwk/activitypub` actors — the last piece connecting Task 9's routes to real data.

- [ ] **Step 1: Write the failing tests**

Add to `packages/activitypub/src/mastodon-api.test.ts`, inside the `describe("buildMastodonBackend", ...)` block (near the `publishStatus()` test):

```ts
it("followRequests() lists pending followers (accepted_at IS NULL), oldest first", async () => {
  const config = freshConfig();
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, NULL, ?, NULL)`,
      "https://remote.example/users/newer",
      20,
    );
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, NULL, ?, NULL)`,
      "https://remote.example/users/older",
      10,
    );
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, ?, ?, ?)`,
      "https://remote.example/users/confirmed",
      "https://remote.example/users/confirmed/inbox",
      5,
      999,
    );
  });
  const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

  const requests = await backend.followRequests!();
  expect(requests.map((r) => r.actor)).toEqual([
    "https://remote.example/users/older",
    "https://remote.example/users/newer",
  ]);
  expect(requests[0]?.addedAt).toBe(10);
});

it("respondToFollowRequest(actor, 'authorize') delivers Accept(Follow) to that follower alone", async () => {
  const config = freshConfig();
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  const follower = "https://remote.example/users/pending";
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, ?, ?, NULL)`,
      follower,
      `${follower}/inbox`,
      1,
    );
  });
  const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

  await backend.respondToFollowRequest!(follower, "authorize");

  await runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec<{ accepted_at: number | null }>(
        `SELECT accepted_at FROM followers WHERE actor = ?`,
        follower,
      )
      .one();
    expect(row.accepted_at).not.toBeNull();
    const queued = state.storage.sql
      .exec<{ actor: string; json: string }>(
        `SELECT actor, json FROM pending_accept WHERE kind = 'deliver'`,
      )
      .toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.actor).toBe(follower);
    expect((JSON.parse(queued[0]!.json) as { type: string }).type).toBe(
      "Accept",
    );
  });
});

it("respondToFollowRequest(actor, 'reject') drops the follower and delivers Reject(Follow)", async () => {
  const config = freshConfig();
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  const follower = "https://remote.example/users/pending2";
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO followers (actor, inbox, added_at, accepted_at) VALUES (?, ?, ?, NULL)`,
      follower,
      `${follower}/inbox`,
      1,
    );
  });
  const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

  await backend.respondToFollowRequest!(follower, "reject");

  await runInDurableObject(stub, async (_instance, state) => {
    const remaining = state.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM followers WHERE actor = ?`,
        follower,
      )
      .one().n;
    expect(remaining).toBe(0);
    const queued = state.storage.sql
      .exec<{ json: string }>(
        `SELECT json FROM pending_accept WHERE kind = 'deliver'`,
      )
      .toArray();
    expect(queued).toHaveLength(1);
    expect((JSON.parse(queued[0]!.json) as { type: string }).type).toBe(
      "Reject",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "followRequests\\|respondToFollowRequest"`
Expected: FAIL — `backend.followRequests`/`backend.respondToFollowRequest` are `undefined` (`buildMastodonBackend` doesn't implement them yet), so calling `backend.followRequests!()` throws.

- [ ] **Step 3: Write minimal implementation**

In `packages/activitypub/src/mastodon-api.ts`, add two members to the object `buildMastodonBackend` returns (after `publishStatus`, before the closing `};`):

```ts
    async followRequests() {
      const response = await stub().fetch(
        new Request(`${config.iris.id}/__client/follow_requests`, {
          headers: internalHeaders(),
        }),
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        items: { actor: string; added_at: number }[];
      };
      return body.items.map((row) => ({
        actor: row.actor,
        addedAt: row.added_at,
      }));
    },

    async respondToFollowRequest(
      actor: string,
      action: "authorize" | "reject",
    ): Promise<void> {
      // POSTs directly to the DO's #publish route (config.iris.outbox),
      // internal fetch — the same "trusted-caller-sets-the-internal-header-
      // directly" pattern mcp-tools.ts's activitypub_publish already uses for
      // /publish. "reject" lands on the existing #447 Reject branch verbatim
      // (zero new DO logic); "authorize" lands on the new (#473) Accept
      // branch. One DO code path, two front doors.
      const headers = internalHeaders();
      headers.set(INTERNAL_HEADERS.publish, "1");
      headers.set("content-type", "application/json");
      const response = await stub().fetch(
        new Request(config.iris.outbox, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: action === "authorize" ? "Accept" : "Reject",
            object: actor,
          }),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `respondToFollowRequest failed (${response.status}): ${await response.text()}`,
        );
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "followRequests\\|respondToFollowRequest"`
Expected: PASS

- [ ] **Step 5: Run the full activitypub and mastodon-api suites**

Run: `pnpm test --project @dwk/activitypub && pnpm test --project @dwk/mastodon-api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/activitypub/src/mastodon-api.ts packages/activitypub/src/mastodon-api.test.ts
git commit -m "feat(activitypub): implement MastodonBackend.followRequests/respondToFollowRequest"
```

---

## Task 11: Update specs and package `CLAUDE.md` files

**Files:**

- Modify: `spec/packages/activitypub.md`
- Modify: `spec/packages/mastodon-api.md`
- Modify: `packages/activitypub/CLAUDE.md`
- Modify: `packages/mastodon-api/CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update `spec/packages/activitypub.md`**

In the "Owner follower control (#447)" section (search for that heading), add a new bullet documenting owner `Accept`/`Remove`:

```markdown
- **Owner Accept / Group moderation (#473).** `Accept` (confirm a pending
  follower) and `Remove` (ban a member / un-announce a post, `Group` actors
  only) published to `POST <actor>/outbox` are routed the same way as
  `Reject`/`Block`: `Accept` delivers privately to the one follower it names
  and marks the `followers` row confirmed; `Remove` reuses exactly the same
  moderator-`Remove` effects as the inbound path (`#onModerationRemove`) but
  is authorized by the bearer `publishToken` alone — the owner is implicitly
  the top moderator of their own actor, independent of the configured
  `moderators` allowlist.
```

- [ ] **Step 2: Update `spec/packages/mastodon-api.md`**

In the "Write surface (opt-in; `config.allowWrites`)" section, add after the existing `POST /api/v1/statuses` bullet:

```markdown
- **`follow_requests` (#473):** `GET /api/v1/follow_requests` (read, not
  `allowWrites`-gated — matches the other read routes) lists pending
  followers as synthesized remote `Account`s. `POST
/api/v1/follow_requests/:id/authorize` and `.../reject` require the same
  `allowWrites` + `write`/`write:follows` scope gate as `POST
/api/v1/statuses`, and return a `Relationship` entity. Backed by
  `MastodonBackend.followRequests?`/`.respondToFollowRequest?`.
```

- [ ] **Step 3: Update `packages/activitypub/CLAUDE.md`**

In the "Owner follower control (#447)" bullet, append a sentence:

```markdown
Owner `Accept` (confirm a pending follower) and `Group`-moderation `Remove`
(ban a member / un-announce a post) follow the identical `POST
  <actor>/outbox` pattern (#473) — see `object.ts` `#routeFollowerControl`'s
`Accept` branch and `#applyModerationRemove`.
```

- [ ] **Step 4: Update `packages/mastodon-api/CLAUDE.md`**

The file currently says "Read-only surface. No write endpoint ships behind these tokens" — this was already inaccurate before this task (`POST /api/v1/statuses` shipped under `config.allowWrites` in an earlier phase). Correct it:

```markdown
- **Read-only by default; opt-in owner-scoped write surface.** With
  `config.allowWrites` absent/`false`, every write route answers `404` and
  the bearer-token exception stays strictly read-only. When enabled, a
  `write`-scoped, owner-bound bearer may post statuses
  (`POST /api/v1/statuses`) and manage pending follow requests
  (`POST /api/v1/follow_requests/:id/authorize`/`reject`). See
  `spec/packages/mastodon-api.md` § Write surface.
```

Replace the existing "Read-only surface..." bullet with this one (don't just append — the old wording is actively wrong now).

- [ ] **Step 5: Verify docs build/lint clean**

Run: `pnpm format:check`
Expected: PASS (Prettier also formats Markdown in this repo — confirm no reformatting is needed; if it fails, run `pnpm format` and re-check the diff is only whitespace)

- [ ] **Step 6: Commit**

```bash
git add spec/packages/activitypub.md spec/packages/mastodon-api.md packages/activitypub/CLAUDE.md packages/mastodon-api/CLAUDE.md
git commit -m "docs(activitypub,mastodon-api): document owner Accept/Remove and follow_requests write surface"
```

---

## Task 12: Changesets

**Files:**

- Create: `.changeset/<auto-generated-name>.md` (one changeset covering both packages — `pnpm changeset` prompts for package selection and writes the file; do not hand-author it)

**Interfaces:** none.

- [ ] **Step 1: Run the changeset CLI**

Run: `pnpm changeset`

When prompted:

- Select both `@dwk/activitypub` and `@dwk/mastodon-api`.
- Bump type: `patch` for both (this repo is in Changesets pre mode — `0.1.0-beta.N` prereleases — per root `CLAUDE.md`; a `patch` bump is correct for an additive, backward-compatible feature under a pre-1.0 prerelease line, matching how #447/#376's follow-on features were released. If unsure, check `.changeset/pre.json` and the most recent merged changeset under `.changeset/` for the convention this repo actually uses before choosing.).
- Summary text (edit the generated file directly if the interactive prompt's editor is inconvenient):

```markdown
---
"@dwk/activitypub": patch
"@dwk/mastodon-api": patch
---

Add owner-admin endpoints: `Accept` (confirm a pending follower) and
`Remove` (ban a `Group` member / un-announce a post) via `POST
<actor>/outbox`, and a `@dwk/mastodon-api` `follow_requests` write surface
(`GET`/`POST .../authorize`/`POST .../reject`) so off-the-shelf Mastodon
clients can manage pending follows too.
```

- [ ] **Step 2: Verify the changeset file was created**

Run: `git status --short .changeset/`
Expected: one new untracked `.md` file.

- [ ] **Step 3: Commit**

```bash
git add .changeset/
git commit -m "chore: add changeset for #473 owner-admin endpoints"
```

---

## Final verification (after all tasks)

- [ ] Run the full local CI gate in order, matching `.github/workflows/ci.yml`:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

Expected: all five PASS.

- [ ] Re-read the design spec (`docs/superpowers/specs/2026-07-30-activitypub-owner-admin-accept-moderation-design.md`) once more and confirm every numbered design section (§1-§4) has a corresponding task above: §1 Accept → Tasks 2-4; §2 Remove → Task 5; §3 mastodon-api → Tasks 6-10; §4 `#asOutboxActivity` fix → Task 1.
