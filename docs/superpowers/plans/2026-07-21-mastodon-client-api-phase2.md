# Mastodon client API phase 2 — read surface (#349) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the phase-2 read surface of the Mastodon client API — home
timeline, notifications, single-status/account reads — so a real client
(Pixelfed's app, Tusky) can log in and see the pixelfed-qa step-4 like +
reply that phase 1 could only confirm indirectly.

**Architecture:** `@dwk/activitypub` gains two additive internal DO routes
(`__client/timeline`, `__client/notifications`, plus a supporting
`__client/entry` single-row lookup) reached the same way `mcp-tools.ts`/
`syndication.ts` already reach `__inbox`/`__following` — a synthetic
`Request` carrying `INTERNAL_HEADERS.config` + `INTERNAL_HEADERS.internal`,
fetched via `actor.get(actor.idFromName(...)).fetch(...)`. A new
`createActivitypubMastodonApi` export in `@dwk/activitypub` implements
`@dwk/mastodon-api`'s `MastodonBackend` seam over those routes and composes
`createMastodonApi`, mirroring `createSolidPodWebdav`'s export shape (not
its in-DO-closures wiring — see the implementation notes). `@dwk/mastodon-api`
gets the snowflake ID codec, the AS2 → Mastodon entity mapping, RFC 8288
`Link` pagination, and the four new routes
(`timelines/home`, `notifications`, `statuses/:id`, `accounts/:id`).

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects (SQLite),
Vitest (`@cloudflare/vitest-pool-workers` for `@dwk/activitypub` and
`@dwk/mastodon-api`; plain `node` for any pure-function tests that don't
need the runtime).

## Global Constraints

- **Composition contract:** no package reads the global environment; all
  config is factory-injected (`spec/composition-contract.md`).
- **Confinement:** Mastodon REST vocabulary stays out of `@dwk/activitypub`;
  it only gains the internal DO routes + the one `createActivitypubMastodonApi`
  export, exactly as phase 1's design promised.
- **No KV for anything authz/consistency-sensitive** — not touched by this
  phase (D1/DO SQLite only), but keep in mind if any caching is tempting.
- **Attacker-supplied content:** every row in `inbox` originated from a
  remote server. Entity fields are built by typed extraction, never spread
  from stored JSON (`entities.ts`'s existing `metadataString`-style pattern).
  HTML passes through an allowlist sanitizer before it reaches a `Status`.
- **No outbound fetches in the request path** for any phase-2 route —
  `spec/mastodon-client-api.md` Security considerations, "No enumeration".
- **Follow notifications are deferred to phase 3/#350** — confirmed decision,
  see `docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md`.
  Phase 2's notification classifier has no `Follow` case.
- **Cursor contract:** internal DO routes bound/tiebreak by `received_at`
  (ms, exact) + `seq` (same-millisecond tiebreak only) — never a bare `seq`
  bound recovered from a snowflake's lossy low 15 bits. See the same
  implementation-notes doc, "Cursor contract" section, for the exact
  parameter shapes used below.
- **Formatting:** Prettier (semicolons, double quotes, trailing commas
  `all`, 80 cols) — `pnpm format` before each commit if unsure.
- **Commit messages:** Conventional Commits,
  `<type>(<scope>): <subject>`, scope = package name(s) minus `@dwk/`.

---

## Task 1: Extend `__stats` with followers/following/statuses counts

**Files:**
- Modify: `packages/activitypub/src/object.ts:1809-1812` (`#stats`)
- Test: `packages/activitypub/src/object.test.ts` (existing file — add a case)

**Interfaces:**
- Consumes: `#count(kind)` (`object.ts:1058-1069`, already supports
  `"followers" | "following" | "outbox"`).
- Produces: `#stats()` response body gains `followers`, `following`,
  `statuses` (in addition to the existing `users`, `localPosts`), consumed
  by Task 6's adapter for `MastodonBackend.account()`.

- [ ] **Step 1: Write the failing test**

Find the existing `__stats` test in `packages/activitypub/src/object.test.ts`
(search for `__stats`) and add a case asserting the new fields, e.g.:

```ts
it("__stats includes followers/following/statuses counts", async () => {
  // ... existing setup that gives this actor 1 outbox post, 1 accepted
  // follower, 1 accepted following (reuse existing test helpers in this
  // file for seeding those tables) ...
  const response = await stub.fetch(
    new Request(`${actorId}/__stats`, {
      headers: { [INTERNAL_HEADERS.config]: JSON.stringify(forwarded) },
    }),
  );
  const body = (await response.json()) as Record<string, number>;
  expect(body.followers).toBe(1);
  expect(body.following).toBe(1);
  expect(body.statuses).toBe(1);
});
```

Match the existing test file's actual setup helpers (seeding followers/
following/outbox rows) — do not invent new ones; grep the file for how
other tests in it seed those three tables and reuse that exact pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub -t "__stats includes followers"`
Expected: FAIL — `body.followers` is `undefined`.

- [ ] **Step 3: Implement**

```ts
  #stats(): Response {
    const localPosts = this.#count("outbox");
    return json(200, {
      users: 1,
      localPosts,
      followers: this.#count("followers"),
      following: this.#count("following"),
      statuses: localPosts,
    } as JsonValue);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub -t "__stats includes followers"`
Expected: PASS. Also run the full package suite to confirm no regression:
`pnpm test --project @dwk/activitypub`

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): extend __stats with follower/following/status counts"
```

---

## Task 2: `__client/timeline` and `__client/notifications` DO routes

**Files:**
- Modify: `packages/activitypub/src/object.ts` (add two private methods +
  two route entries in `#route`, near the existing `__inbox`/`__following`
  block at lines 291-312)
- Test: `packages/activitypub/src/object.test.ts` (add cases)

**Interfaces:**
- Consumes: `INTERNAL_HEADERS.internal` gate (`config.ts:203-210`, same
  pattern as `__inbox`); `this.#sql` (DO SQLite handle); `JsonValue` type.
- Produces:
  - `GET <actor>/__client/timeline?limit=&max_received_at=&since_received_at=&min_received_at=&tie_seq=`
    → `{ items: ClientEntry[] }` (newest-first unless `min_received_at` is
    set, in which case oldest-first — see Mastodon's `min_id` semantics).
  - `GET <actor>/__client/notifications?limit=&max_received_at=&since_received_at=&min_received_at=&tie_seq=`
    → same shape, filtered to favourite/reblog/mention rows.
  - `ClientEntry` shape (both routes): `{ seq: number, receivedAt: number,
    activity: JsonValue, relayedBy: string | null }`. `id`/`objectType`/
    `verifyState` are not needed by the adapter (it works from the parsed
    `activity` for classification) so they are omitted from the wire shape
    to keep the row payload small.
  - Both routes are gated by `INTERNAL_HEADERS.internal !== "1" → 404`,
    exactly like `__inbox`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/activitypub/src/object.test.ts` (reuse this file's
existing helpers for building a `forwarded` config and seeding `inbox` rows
— grep the file for how the `__inbox` tests insert rows, e.g. via a raw
`POST /inbox` through the DO's own `fetch`, which is the realistic path and
exercises `classifyActivity`/`#storeInbox` for real rather than hand-writing
SQL):

```ts
describe("__client/timeline", () => {
  it("404s without the internal marker", async () => {
    const response = await stub.fetch(
      new Request(`${actorId}/__client/timeline`, {
        headers: { [INTERNAL_HEADERS.config]: JSON.stringify(forwarded) },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("returns Create/Announce rows newest-first, excluding Like rows", async () => {
    // Deliver a Like (from actor B) and a Create/Note (from actor B) into
    // the inbox via the same inbound-POST path other tests in this file
    // use (search this file for an existing "deliver an inbound Create"
    // helper/test and reuse its request-building code verbatim).
    await deliverInbound(likeActivity);
    await deliverInbound(createNoteActivity);

    const response = await stub.fetch(
      new Request(`${actorId}/__client/timeline?limit=10`, {
        headers: {
          [INTERNAL_HEADERS.config]: JSON.stringify(forwarded),
          [INTERNAL_HEADERS.internal]: "1",
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { activity: { type: string } }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.activity.type).toBe("Create");
  });

  it("paginates with max_received_at + tie_seq without skipping or duplicating", async () => {
    // Deliver 3 Create/Note activities in sequence, fetch with limit=2,
    // then fetch again using the last item's receivedAt/seq as the next
    // page's max_received_at/tie_seq bounds, and assert the third item
    // appears exactly once across both pages combined.
  });
});

describe("__client/notifications", () => {
  it("classifies Like as favourite and Announce-of-local as reblog, omits Follow", async () => {
    // Deliver a Like and an Announce whose object is this actor's own
    // outbox post id; assert both appear. Confirm no Follow row ever
    // appears (Follows never reach `inbox` at all — this documents the
    // phase-3-deferred gap rather than silently relying on it).
  });
});
```

Fill in `deliverInbound`/`likeActivity`/`createNoteActivity` using this
test file's own existing conventions for constructing and delivering a
signed (or test-mode-unsigned, whatever this file already does) inbound
activity — do not invent a new delivery path; grep for the file's existing
`Like`/`Create` inbound test cases and copy their setup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/activitypub -t "__client"`
Expected: FAIL — route returns 404/undefined for all cases (route doesn't
exist yet).

- [ ] **Step 3: Implement the two routes**

Add to `#route` (`object.ts`, right after the existing `__following` block,
before the `if (path === pathOf(iris.followers))` line):

```ts
    if (path === `${pathOf(iris.id)}/__client/timeline`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listClientEntries(request, "timeline");
    }
    if (path === `${pathOf(iris.id)}/__client/notifications`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#listClientEntries(request, "notifications");
    }
    if (path === `${pathOf(iris.id)}/__client/entry`) {
      if (request.headers.get(INTERNAL_HEADERS.internal) !== "1") {
        return text(404, "not found");
      }
      return this.#clientEntry(request);
    }
```

Add these private methods near `#listInbox`/`#listFollowing`
(`object.ts:1106-1168`):

```ts
  /**
   * Classification used by `__client/timeline`/`__client/notifications`
   * (Mastodon client API phase 2, spec/mastodon-client-api.md Decision 3).
   * Read-time, over the parsed activity JSON — `object_type` alone can't
   * distinguish these (it reflects the *embedded object's* type, not the
   * activity's own, and is null for bare-IRI objects like most `Like`s).
   * `Follow` is deliberately absent: inbound Follows never reach `inbox`
   * (see docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md).
   */
  #classifyClientEntry(
    activity: ActivityObject,
  ): "timeline" | "favourite" | "reblog" | "mention" | null {
    const type = activity.type;
    if (type === "Create" || type === "Update") {
      const objType = objectType(activity.object);
      const postShapes = ["Note", "Article", "Page", "Video"];
      if (objType !== undefined && postShapes.includes(objType)) {
        return "timeline";
      }
      // A reply/mention targeting this actor is a notification, not a
      // timeline entry (the timeline is "things I follow posted", the
      // notification is "someone addressed me").
      const object = activity.object;
      const inReplyTo =
        object && typeof object === "object" && !Array.isArray(object)
          ? (object as Record<string, JsonValue>).inReplyTo
          : undefined;
      if (typeof inReplyTo === "string" && inReplyTo.startsWith(this.#config!.iris.id)) {
        return "mention";
      }
      return null;
    }
    if (type === "Like") return "favourite";
    if (type === "Announce") return "reblog";
    return null;
  }

  /**
   * Shared cursor-paginated reader for `__client/timeline` and
   * `__client/notifications`. Fetches `inbox` rows in `received_at DESC,
   * seq DESC` batches (oldest-first when `min_received_at` selects the
   * opposite direction), classifies each row, keeps the ones matching
   * `kind`, and repeats until either `limit` matches are collected or the
   * table is exhausted — a single bounded `SELECT ... LIMIT ?` cannot fill
   * the page reliably once classification discards non-matching rows.
   */
  #listClientEntries(
    request: Request,
    kind: "timeline" | "notifications",
  ): Response {
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20),
      100,
    );
    const maxReceivedAt = url.searchParams.get("max_received_at");
    const sinceReceivedAt = url.searchParams.get("since_received_at");
    const minReceivedAt = url.searchParams.get("min_received_at");
    const tieSeq = url.searchParams.get("tie_seq");

    const oldestFirst = minReceivedAt !== null;
    let where = "verify_state IS NOT 'failed'"; // defensive; see cursor-contract note
    const params: (string | number)[] = [];
    if (maxReceivedAt !== null) {
      where += tieSeq !== null
        ? " AND (received_at < ? OR (received_at = ? AND seq < ?))"
        : " AND received_at < ?";
      params.push(Number(maxReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(maxReceivedAt), Number(tieSeq));
      }
    }
    if (sinceReceivedAt !== null) {
      where += tieSeq !== null
        ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
        : " AND received_at > ?";
      params.push(Number(sinceReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(sinceReceivedAt), Number(tieSeq));
      }
    }
    if (minReceivedAt !== null) {
      where += tieSeq !== null
        ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
        : " AND received_at > ?";
      params.push(Number(minReceivedAt));
      if (tieSeq !== null) {
        params.push(Number(minReceivedAt), Number(tieSeq));
      }
    }

    const order = oldestFirst ? "ASC" : "DESC";
    const matches: {
      seq: number;
      receivedAt: number;
      activity: JsonValue;
      relayedBy: string | null;
    }[] = [];
    // Classify-and-fill: batches of 4x the page size keep the number of
    // round-trips small for the common case (most rows are timeline-shaped)
    // while still terminating once the table is exhausted.
    const BATCH = Math.max(limit * 4, 40);
    let cursorReceivedAt = maxReceivedAt !== null
      ? Number(maxReceivedAt)
      : sinceReceivedAt !== null
        ? Number(sinceReceivedAt)
        : minReceivedAt !== null
          ? Number(minReceivedAt)
          : null;
    let cursorSeq = tieSeq !== null ? Number(tieSeq) : null;
    let exhausted = false;
    while (matches.length < limit && !exhausted) {
      let batchWhere = where;
      const batchParams = [...params];
      if (cursorReceivedAt !== null && matches.length > 0) {
        // Subsequent internal batches page from the last row seen so far.
        batchWhere += cursorSeq !== null
          ? oldestFirst
            ? " AND (received_at > ? OR (received_at = ? AND seq > ?))"
            : " AND (received_at < ? OR (received_at = ? AND seq < ?))"
          : oldestFirst
            ? " AND received_at > ?"
            : " AND received_at < ?";
        batchParams.push(cursorReceivedAt);
        if (cursorSeq !== null) batchParams.push(cursorReceivedAt, cursorSeq);
      }
      const rows = this.#sql
        .exec<{
          seq: number;
          json: string;
          received_at: number;
          relayed_by: string | null;
        }>(
          `SELECT seq, json, received_at, relayed_by FROM inbox
             WHERE ${batchWhere} ORDER BY received_at ${order}, seq ${order} LIMIT ?`,
          ...batchParams,
          BATCH,
        )
        .toArray();
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const row of rows) {
        const activity = JSON.parse(row.json) as ActivityObject;
        const classification = this.#classifyClientEntry(activity);
        const wanted =
          kind === "timeline"
            ? classification === "timeline"
            : classification === "favourite" ||
              classification === "reblog" ||
              classification === "mention";
        if (wanted) {
          matches.push({
            seq: row.seq,
            receivedAt: row.received_at,
            activity: activity as unknown as JsonValue,
            relayedBy: row.relayed_by,
          });
          if (matches.length >= limit) break;
        }
      }
      const last = rows[rows.length - 1];
      cursorReceivedAt = last!.received_at;
      cursorSeq = last!.seq;
      if (rows.length < BATCH) exhausted = true;
    }

    return json(200, { items: matches } as unknown as JsonValue);
  }

  /**
   * `__client/entry?received_at=<ms>&seq_low=<0-32767>` — single-row lookup
   * for `statuses/:id`. `seq_low` disambiguates the (vanishingly rare) case
   * of two rows sharing a millisecond; the common case matches on
   * `received_at` alone.
   */
  #clientEntry(request: Request): Response {
    const url = new URL(request.url);
    const receivedAt = Number(url.searchParams.get("received_at"));
    const seqLow = url.searchParams.get("seq_low");
    if (!Number.isFinite(receivedAt)) return json(404, { error: "not found" } as JsonValue);
    const rows = this.#sql
      .exec<{ seq: number; json: string; received_at: number; relayed_by: string | null }>(
        `SELECT seq, json, received_at, relayed_by FROM inbox WHERE received_at = ? ORDER BY seq`,
        receivedAt,
      )
      .toArray();
    const row =
      seqLow !== null
        ? rows.find((r) => r.seq % 32768 === Number(seqLow)) ?? rows[0]
        : rows[0];
    if (!row) return json(404, { error: "not found" } as JsonValue);
    return json(200, {
      seq: row.seq,
      receivedAt: row.received_at,
      activity: JSON.parse(row.json) as JsonValue,
      relayedBy: row.relayed_by,
    } as unknown as JsonValue);
  }
```

Add `objectType` to the existing `import { ... } from "./as2.js"` block at
the top of `object.ts` (it's already imported — confirm at line 23; if a
different helper is needed for `ActivityObject`, it's also already imported
at line 24).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub -t "__client"`
Expected: PASS. Then the full suite: `pnpm test --project @dwk/activitypub`

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts
git commit -m "feat(activitypub): additive __client/timeline, __client/notifications, __client/entry DO routes"
```

---

## Task 3: `@dwk/mastodon-api` snowflake ID codec

**Files:**
- Create: `packages/mastodon-api/src/snowflake.ts`
- Test: `packages/mastodon-api/src/snowflake.test.ts`

**Interfaces:**
- Produces: `encodeSnowflake(receivedAtMs: number, seq: number): string`,
  `decodeSnowflake(id: string): { receivedAtMs: number, seqLow: number } | null`.
  Consumed by Task 6 (activitypub adapter, to build `BackendEntry.id` and to
  decode client-supplied `maxId`/`sinceId`/`minId`) and Task 8 (entity
  mapping, which just treats ids as opaque strings it receives from
  `BackendEntry.id`).

This is a pure `node`-testable module — no Workers runtime needed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { decodeSnowflake, encodeSnowflake } from "./snowflake.js";

describe("snowflake codec", () => {
  it("round-trips receivedAtMs exactly and seq modulo 32768", () => {
    const id = encodeSnowflake(1_753_000_000_000, 42);
    const decoded = decodeSnowflake(id);
    expect(decoded).toEqual({ receivedAtMs: 1_753_000_000_000, seqLow: 42 });
  });

  it("wraps seq at 32768", () => {
    const id = encodeSnowflake(1_753_000_000_000, 32768 + 42);
    expect(decodeSnowflake(id)).toEqual({
      receivedAtMs: 1_753_000_000_000,
      seqLow: 42,
    });
  });

  it("produces a decimal string with no leading source-bit ambiguity", () => {
    const id = encodeSnowflake(1_753_000_000_000, 0);
    expect(/^\d+$/.test(id)).toBe(true);
  });

  it("decode rejects non-numeric input", () => {
    expect(decodeSnowflake("not-a-number")).toBeNull();
    expect(decodeSnowflake("1")).not.toBeNull(); // small ids are still valid
  });

  it("orders chronologically as a string comparison would only work numerically, not lexically for varying digit counts — callers must compare as BigInt, not string", () => {
    const earlier = encodeSnowflake(1_753_000_000_000, 0);
    const later = encodeSnowflake(1_753_000_000_001, 0);
    expect(BigInt(later) > BigInt(earlier)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api snowflake`
Expected: FAIL — `./snowflake.js` doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Mastodon-shaped snowflake IDs for phase-2 inbox-derived entries
 * (spec/mastodon-client-api.md Decision 3): `(receivedAtMs << 16) |
 * (source << 15) | (seq & 0x7FFF)`, rendered as a decimal string. `source`
 * is reserved (always `0` — inbox rows only in v1; phase 3 reserves `1` for
 * outbox-derived rows without changing already-persisted IDs). The low 15
 * bits of `seq` only break same-millisecond ties — they are NOT a lossless
 * encoding of a DO's `seq` column, so decoding recovers `receivedAtMs`
 * exactly but only `seq mod 32768`. Callers needing the exact row use
 * `receivedAtMs` as the primary key and the low bits only to disambiguate
 * a same-millisecond collision (see the activitypub adapter).
 */

const SEQ_BITS = 16n; // 1 source bit + 15 sequence bits
const SEQ_MASK = 0x7fffn;

export function encodeSnowflake(receivedAtMs: number, seq: number): string {
  const ms = BigInt(Math.trunc(receivedAtMs));
  const low = BigInt(Math.trunc(seq)) & SEQ_MASK; // source bit 0 = inbox
  return ((ms << SEQ_BITS) | low).toString(10);
}

export interface DecodedSnowflake {
  readonly receivedAtMs: number;
  readonly seqLow: number;
}

export function decodeSnowflake(id: string): DecodedSnowflake | null {
  if (!/^\d+$/.test(id)) return null;
  let value: bigint;
  try {
    value = BigInt(id);
  } catch {
    return null;
  }
  const seqLow = Number(value & SEQ_MASK);
  const receivedAtMs = Number(value >> SEQ_BITS);
  if (!Number.isSafeInteger(receivedAtMs)) return null;
  return { receivedAtMs, seqLow };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api snowflake`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/snowflake.ts packages/mastodon-api/src/snowflake.test.ts
git commit -m "feat(mastodon-api): Mastodon-shaped snowflake ID codec"
```

---

## Task 4: `@dwk/mastodon-api` allowlist HTML sanitizer

**Files:**
- Create: `packages/mastodon-api/src/sanitize.ts`
- Test: `packages/mastodon-api/src/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeStatusHtml(html: string): string`. Consumed by Task 8
  (`statusEntity`'s `content` field).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { sanitizeStatusHtml } from "./sanitize.js";

describe("sanitizeStatusHtml", () => {
  it("keeps allowlisted tags and their href/rel", () => {
    const input = '<p>Hello <a href="https://example.com" rel="me">world</a></p>';
    expect(sanitizeStatusHtml(input)).toBe(input);
  });

  it("strips script tags and their content entirely", () => {
    expect(sanitizeStatusHtml("<p>hi</p><script>alert(1)</script>")).toBe(
      "<p>hi</p>",
    );
  });

  it("strips event-handler attributes", () => {
    expect(sanitizeStatusHtml('<a href="/" onclick="evil()">x</a>')).toBe(
      '<a href="/">x</a>',
    );
  });

  it("strips non-allowlisted tags but keeps their text content", () => {
    expect(sanitizeStatusHtml("<div>hi <b>there</b></div>")).toBe(
      "hi <b>there</b>",
    );
  });

  it("drops javascript: URLs", () => {
    expect(sanitizeStatusHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api sanitize`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

A small hand-rolled walker, not a parser dependency (runtime-budget
constraint — `spec/non-functional-requirements.md`). It operates on the
tag-token level with a regex tokenizer, which is safe here because the
output is only ever used as HTML *text* rendered by a client, not
re-parsed as trusted markup on this origin.

```ts
/**
 * Small allowlist HTML sanitizer for inbound status content (attacker
 * supplied — every inbox row originated from a remote server). No parser
 * dependency (runtime budget); works at the tag-token level. Unknown tags
 * are stripped but their text content is kept; allowlisted tags keep only
 * their allowlisted attributes, and `href`/`src` reject non-http(s) schemes.
 */

const ALLOWED_TAGS = new Set(["p", "br", "a", "span", "b", "strong", "i", "em", "ul", "ol", "li"]);
const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "rel", "class", "target"],
  span: ["class"],
};

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g;
const ATTR_RE = /([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'|[^\s>]*))?/g;

function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (/^(https?:)?\/\//i.test(value) || value.startsWith("/") || value.startsWith("#")) {
    return value;
  }
  return null;
}

export function sanitizeStatusHtml(html: string): string {
  let out = "";
  let lastIndex = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    out += html.slice(lastIndex, match.index);
    lastIndex = TAG_RE.lastIndex;
    const [full, rawName, rawAttrs] = match;
    const name = (rawName ?? "").toLowerCase();
    const isClosing = full.startsWith("</");
    if (name === "script" || name === "style") {
      // Skip to the matching closing tag, dropping all content between.
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(lastIndex);
      const closeMatch = closeRe.exec(rest);
      if (closeMatch) {
        lastIndex += closeMatch.index + closeMatch[0].length;
        TAG_RE.lastIndex = lastIndex;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // strip tag, keep surrounding text
    if (isClosing) {
      out += `</${name}>`;
      continue;
    }
    const allowedAttrs = ALLOWED_ATTRS[name] ?? [];
    let attrsOut = "";
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(rawAttrs ?? "")) !== null) {
      const attrName = (attrMatch[1] ?? "").toLowerCase();
      if (!allowedAttrs.includes(attrName)) continue;
      let value = (attrMatch[2] ?? "").replace(/^["']|["']$/g, "");
      if (attrName === "href" || attrName === "src") {
        const safe = safeUrl(value);
        if (safe === null) continue;
        value = safe;
      }
      attrsOut += ` ${attrName}="${value.replace(/"/g, "&quot;")}"`;
    }
    const selfClosing = full.endsWith("/>") && name === "br";
    out += `<${name}${attrsOut}${selfClosing ? " /" : ""}>`;
  }
  out += html.slice(lastIndex);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api sanitize`
Expected: PASS (5 tests). If the `javascript:` test fails because
`safeUrl` doesn't reject it explicitly, confirm `/^(https?:)?\/\//i` really
doesn't match `javascript:alert(1)` (it shouldn't — no `//`) and that
`startsWith("/")`/`startsWith("#")` also don't match; adjust only if a real
counterexample is found, don't weaken the allowlist.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/sanitize.ts packages/mastodon-api/src/sanitize.test.ts
git commit -m "feat(mastodon-api): allowlist HTML sanitizer for inbound status content"
```

---

## Task 5: Entity mapping — `Status` from timeline entries

**Files:**
- Modify: `packages/mastodon-api/src/entities.ts` (add `statusEntity`,
  `remoteAccountEntity`, `REMOTE_ACCOUNT_PREFIX`)
- Test: `packages/mastodon-api/src/entities.test.ts` (add cases)

**Interfaces:**
- Consumes: `BackendEntry` (`backend.ts:31-38`, already defined),
  `sanitizeStatusHtml` (Task 4), `TRANSPARENT_PIXEL` (already in
  `entities.ts`).
- Produces: `statusEntity(entry: BackendEntry, opts: { baseUrl: string })
  : Record<string, unknown>`, `remoteAccountEntity(actorIri: string):
  Record<string, unknown>`, `encodeRemoteAccountId(actorIri: string):
  string`, `decodeRemoteAccountId(id: string): string | null`. Consumed by
  Task 10 (timeline/notification route handlers) and Task 12
  (`accounts/:id`).

Remote account IDs are `"r_" + base64url(actorIri)` — reversible, so
`GET /api/v1/accounts/:id` for a non-owner id re-synthesizes the same
best-effort account directly from the decoded IRI with **no backend call
and no outbound fetch** (design doc: "no enumeration... makes no outbound
fetches in the request path"). This is a v1 simplification within the
approved `MastodonBackend` seam's 4 methods — no new backend method needed.

- [ ] **Step 1: Write the failing tests**

Add to `entities.test.ts`:

```ts
import { statusEntity, remoteAccountEntity, encodeRemoteAccountId, decodeRemoteAccountId } from "./entities.js";
import { encodeSnowflake } from "./snowflake.js";
import type { BackendEntry } from "./backend.js";

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
        object: { id: "https://remote.example/objects/2", type: "Note", content: "<p>bird</p>" },
      },
    };
    const status = statusEntity(entry, { baseUrl });
    expect((status.account as { acct: string }).acct).toContain("birding");
    expect(status.reblog).not.toBeNull();
    expect((status.reblog as { content: string }).content).toBe("<p>bird</p>");
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/mastodon-api entities`
Expected: FAIL — `statusEntity`/`remoteAccountEntity`/etc. don't exist.

- [ ] **Step 3: Implement**

Add to `entities.ts` (after the existing `markerEntity`):

```ts
import { sanitizeStatusHtml } from "./sanitize.js";
import type { BackendEntry } from "./backend.js";

const REMOTE_ACCOUNT_PREFIX = "r_";

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return atob(padded + pad);
  } catch {
    return null;
  }
}

/** Reversible remote-account id — see Task 5's header note on why. */
export function encodeRemoteAccountId(actorIri: string): string {
  return REMOTE_ACCOUNT_PREFIX + base64UrlEncode(actorIri);
}

export function decodeRemoteAccountId(id: string): string | null {
  if (!id.startsWith(REMOTE_ACCOUNT_PREFIX)) return null;
  return base64UrlDecode(id.slice(REMOTE_ACCOUNT_PREFIX.length));
}

/** Best-effort local part from an actor IRI's path (last segment). */
function usernameFromIri(actorIri: string): string {
  try {
    const url = new URL(actorIri);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? url.hostname;
  } catch {
    return actorIri;
  }
}

/**
 * Best-effort remote `Account`, synthesized purely from the actor IRI — no
 * backend call, no outbound fetch (design doc: "no enumeration"). Embedded
 * actor-document enrichment is phase 3's actor-profile hydration cache.
 */
export function remoteAccountEntity(actorIri: string): Record<string, unknown> {
  const username = usernameFromIri(actorIri);
  let host = actorIri;
  try {
    host = new URL(actorIri).hostname;
  } catch {
    /* fall through with the raw IRI as a last resort */
  }
  return {
    id: encodeRemoteAccountId(actorIri),
    username,
    acct: `${username}@${host}`,
    display_name: username,
    locked: false,
    bot: false,
    discoverable: false,
    group: false,
    created_at: "1970-01-01T00:00:00.000Z",
    note: "",
    url: actorIri,
    avatar: TRANSPARENT_PIXEL,
    avatar_static: TRANSPARENT_PIXEL,
    header: TRANSPARENT_PIXEL,
    header_static: TRANSPARENT_PIXEL,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
}

interface RawAttachment {
  readonly type?: string;
  readonly url?: string;
  readonly mediaType?: string;
  readonly name?: string;
  readonly blurhash?: string;
}

const MEDIA_TYPE_MAP: Record<string, string> = {
  Image: "image",
  Video: "video",
  Audio: "audio",
  Document: "unknown",
};

function mediaAttachments(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((item): item is RawAttachment => typeof item === "object" && item !== null)
    .map((item, index) => ({
      id: String(index),
      type: MEDIA_TYPE_MAP[item.type ?? ""] ?? "unknown",
      url: item.url ?? "",
      preview_url: item.url ?? "",
      description: item.name ?? null,
      blurhash: item.blurhash ?? null,
      meta: {},
    }));
}

/**
 * `Create`/`Announce` row → `Status`. A `relayed_by` row is wrapped as a
 * reblog attributed to the relaying group's account (FEP-1b12 provenance —
 * spec/mastodon-client-api.md Decision 3's MCP-spec provenance requirement).
 */
export function statusEntity(
  entry: BackendEntry,
  opts: { readonly baseUrl: string },
): Record<string, unknown> {
  const activity = entry.activity as {
    readonly type?: string;
    readonly actor?: unknown;
    readonly object?: {
      readonly id?: string;
      readonly content?: string;
      readonly summary?: string;
      readonly sensitive?: boolean;
      readonly inReplyTo?: string;
      readonly attachment?: unknown;
      readonly published?: string;
    };
  };
  const actorIri = typeof activity.actor === "string" ? activity.actor : "";
  const object = activity.object ?? {};
  const content = sanitizeStatusHtml(object.content ?? "");
  const uri = object.id ?? entry.id;

  const inner: Record<string, unknown> = {
    id: entry.id,
    created_at: object.published ?? new Date(entry.receivedAt).toISOString(),
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: object.sensitive ?? false,
    spoiler_text: object.summary ?? "",
    visibility: "public",
    language: null,
    uri,
    url: uri,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    content,
    reblog: null,
    account: actorIri ? remoteAccountEntity(actorIri) : remoteAccountEntity(opts.baseUrl),
    media_attachments: mediaAttachments(object.attachment),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };

  if (entry.relayedBy) {
    return {
      ...inner,
      id: entry.id,
      content: "",
      spoiler_text: "",
      media_attachments: [],
      account: remoteAccountEntity(entry.relayedBy),
      reblog: inner,
    };
  }
  return inner;
}
```

Note: `in_reply_to_id` resolution to a **local** snowflake (per the design
doc: "`inReplyTo` → `in_reply_to_id` when it resolves to a local snowflake,
else null") needs the *caller* (the route handler in Task 10) to pass in a
resolver, since `statusEntity` itself has no backend access — leave it
`null` for now in this task; Task 10 documents this as a follow-up if
`entry(id)` lookups per-status prove necessary for the acceptance bar (the
pixelfed-qa reply only needs to show up as a *notification*, not require
in-thread linking to render — see Task 6/#350 fidelity phase for full
threading).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api entities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/entities.ts packages/mastodon-api/src/entities.test.ts
git commit -m "feat(mastodon-api): Status entity mapping with reblog provenance and remote-account synthesis"
```

---

## Task 6: Entity mapping — `Notification`

**Files:**
- Modify: `packages/mastodon-api/src/entities.ts` (add `notificationEntity`)
- Test: `packages/mastodon-api/src/entities.test.ts` (add cases)

**Interfaces:**
- Consumes: `statusEntity`, `remoteAccountEntity` (Task 5).
- Produces: `notificationEntity(entry: BackendEntry, opts: { baseUrl:
  string }): Record<string, unknown> | null` — `null` for a row that
  classifies to none of `favourite`/`reblog`/`mention` (the design doc:
  "Rows that fit no type are omitted from this endpoint"). Consumed by
  Task 11 (`GET /api/v1/notifications`).

- [ ] **Step 1: Write the failing tests**

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/mastodon-api entities`
Expected: FAIL — `notificationEntity` doesn't exist.

- [ ] **Step 3: Implement**

Add to `entities.ts`:

```ts
/**
 * `Like`/`Announce`/reply-`Create` row → `Notification`, or `null` if the
 * row fits none of the phase-2 notification types. `Follow` is
 * deliberately unhandled — see the phase-2 implementation notes.
 */
export function notificationEntity(
  entry: BackendEntry,
  opts: { readonly baseUrl: string },
): Record<string, unknown> | null {
  const activity = entry.activity as {
    readonly type?: string;
    readonly actor?: unknown;
    readonly object?: unknown;
  };
  const actorIri = typeof activity.actor === "string" ? activity.actor : "";
  const account = actorIri ? remoteAccountEntity(actorIri) : remoteAccountEntity(opts.baseUrl);

  if (activity.type === "Like") {
    return {
      id: entry.id,
      type: "favourite",
      created_at: new Date(entry.receivedAt).toISOString(),
      account,
      status: null,
    };
  }
  if (activity.type === "Announce") {
    return {
      id: entry.id,
      type: "reblog",
      created_at: new Date(entry.receivedAt).toISOString(),
      account,
      status: null,
    };
  }
  if (activity.type === "Create") {
    const object = activity.object;
    const inReplyTo =
      object && typeof object === "object" && !Array.isArray(object)
        ? (object as Record<string, unknown>).inReplyTo
        : undefined;
    if (typeof inReplyTo === "string" && inReplyTo.startsWith(opts.baseUrl)) {
      return {
        id: entry.id,
        type: "mention",
        created_at: new Date(entry.receivedAt).toISOString(),
        account,
        status: statusEntity(entry, opts),
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api entities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/entities.ts packages/mastodon-api/src/entities.test.ts
git commit -m "feat(mastodon-api): Notification entity mapping (favourite/reblog/mention)"
```

---

## Task 7: RFC 8288 `Link` pagination helper

**Files:**
- Create: `packages/mastodon-api/src/pagination.ts`
- Test: `packages/mastodon-api/src/pagination.test.ts`

**Interfaces:**
- Produces: `buildLinkHeader(requestUrl: URL, page: { firstId?: string,
  lastId?: string }): string | null`. Consumed by Task 10/11.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { buildLinkHeader } from "./pagination.js";

describe("buildLinkHeader", () => {
  it("builds next (max_id=last) and prev (min_id=first) links", () => {
    const url = new URL("https://owner.example/api/v1/timelines/home?limit=20");
    const header = buildLinkHeader(url, { firstId: "100", lastId: "1" });
    expect(header).toBe(
      '<https://owner.example/api/v1/timelines/home?limit=20&max_id=1>; rel="next", ' +
        '<https://owner.example/api/v1/timelines/home?limit=20&min_id=100>; rel="prev"',
    );
  });

  it("returns null for an empty page", () => {
    expect(buildLinkHeader(new URL("https://owner.example/api/v1/timelines/home"), {})).toBeNull();
  });

  it("replaces an existing max_id/min_id rather than duplicating it", () => {
    const url = new URL("https://owner.example/api/v1/timelines/home?max_id=999");
    const header = buildLinkHeader(url, { firstId: "100", lastId: "1" });
    expect(header).toContain("max_id=1>");
    expect(header).not.toContain("max_id=999");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api pagination`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * RFC 8288 `Link: rel="next"/"prev"` pagination header, Mastodon's own
 * convention: `next` pages backward in time (`max_id` = the last/oldest
 * item shown), `prev` pages forward (`min_id` = the first/newest item
 * shown). Every Mastodon client pages this way.
 */
export function buildLinkHeader(
  requestUrl: URL,
  page: { readonly firstId?: string; readonly lastId?: string },
): string | null {
  if (!page.firstId && !page.lastId) return null;
  const parts: string[] = [];
  if (page.lastId) {
    const next = new URL(requestUrl);
    next.searchParams.delete("min_id");
    next.searchParams.delete("since_id");
    next.searchParams.set("max_id", page.lastId);
    parts.push(`<${next.toString()}>; rel="next"`);
  }
  if (page.firstId) {
    const prev = new URL(requestUrl);
    prev.searchParams.delete("max_id");
    prev.searchParams.set("min_id", page.firstId);
    parts.push(`<${prev.toString()}>; rel="prev"`);
  }
  return parts.join(", ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api pagination`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/pagination.ts packages/mastodon-api/src/pagination.test.ts
git commit -m "feat(mastodon-api): RFC 8288 Link header pagination helper"
```

---

## Task 8: `@dwk/activitypub` — `createActivitypubMastodonApi` adapter

**Files:**
- Create: `packages/activitypub/src/mastodon-api.ts`
- Modify: `packages/activitypub/src/index.ts` (export)
- Modify: `packages/activitypub/package.json` (add `@dwk/mastodon-api` dep)
- Modify: `packages/activitypub/CLAUDE.md` (file layout table)
- Test: `packages/activitypub/src/mastodon-api.test.ts`

**Interfaces:**
- Consumes: `MastodonBackend`/`BackendAccount`/`BackendPage`/
  `BackendPageQuery`/`BackendEntry` (`@dwk/mastodon-api`'s `backend.ts`),
  `createMastodonApi`/`MastodonApiConfig` (`@dwk/mastodon-api`),
  `INTERNAL_HEADERS`, `forwardedConfig` (`./handler.js`), `ResolvedConfig`
  (`./config.js`), `encodeSnowflake`/`decodeSnowflake`
  (`@dwk/mastodon-api`'s `snowflake.js` — exported from its `index.ts` in
  Task 9).
- Produces: `createActivitypubMastodonApi(options: {
  config: ResolvedConfig, actor: DurableObjectNamespace<ActivityPubObject>,
  mastodonConfig: Omit<MastodonApiConfig, "backend">,
}): (request: Request, env: MastodonApiEnv & ActivityPubEnv, ctx:
  ExecutionContext) => Promise<Response>`. Mounted directly by composers
  (conformance-target in Task 13, the catalog entry already declares
  `handler: "createMastodonApi"` — Task 13 also confirms whether the
  catalog needs updating to `createActivitypubMastodonApi`, since that's
  the actual mounted symbol per the design doc's Composition section).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { createActivitypubMastodonApi } from "./mastodon-api.js";
import { resolveConfig } from "./config.js";
import type { ActivityPubEnv } from "./config.js";
import type { MastodonApiEnv } from "@dwk/mastodon-api";

// Reuse this package's existing test-harness config-building helpers
// (`test-harness.ts`) for `resolveConfig` inputs — do not hand-roll a new
// actor config shape; grep test-harness.ts for the existing pattern other
// *.test.ts files in this package use for `env.ACTOR`.

describe("createActivitypubMastodonApi", () => {
  it("serves timelines/home backed by real inbox rows", async () => {
    // 1. Build `config` via this package's existing `resolveConfig` test
    //    fixture (see any other object.test.ts / handler.test.ts for the
    //    exact input shape already used in this package's tests).
    // 2. Deliver one Create/Note into the actor's inbox via the DO's own
    //    `fetch`, the same way object.test.ts does it.
    // 3. Build the handler:
    //    const handler = createActivitypubMastodonApi({
    //      config, actor: env.ACTOR,
    //      mastodonConfig: { baseUrl: config.baseUrl, instance: { title: "t" },
    //        account: { username: config.actor.username },
    //        approveAuthorization: async () => ({ approved: true }) },
    //    });
    // 4. Register an app + obtain a bearer token the same way
    //    `@dwk/mastodon-api`'s own test-harness does (import its
    //    `registerApp`/`obtainAccessToken` from
    //    `@dwk/mastodon-api/dist/test-harness.js`? — NO: test-harness.ts is
    //    excluded from the build. Instead, drive `handler` directly through
    //    its own `/api/v1/apps` → `/oauth/authorize` → `/oauth/token` route
    //    sequence inline in this test, exactly like
    //    packages/mastodon-api/src/test-harness.ts's `obtainAccessToken`
    //    does — copy that logic here since it can't be imported cross-package.
    // 5. GET /api/v1/timelines/home with the bearer token; assert 200 and
    //    that the delivered Note appears with sanitized content.
  });

  it("account() surfaces live counts from __stats", async () => {
    // Deliver a follower + a post, call verify_credentials, assert
    // followers_count/statuses_count reflect them.
  });
});
```

Because `@dwk/mastodon-api`'s test-harness (`registerApp`/
`obtainAccessToken`) is excluded from its published build and can't be
imported from `@dwk/activitypub`'s tests, inline the same three-request
sequence (register app → authorize → token) directly in this test file —
it's ~15 lines, matching `packages/mastodon-api/src/test-harness.ts:55-115`
verbatim but pointed at `handler` instead of `@dwk/mastodon-api`'s own
`api()` helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub mastodon-api`
Expected: FAIL — `./mastodon-api.js` doesn't exist.

- [ ] **Step 3: Implement**

```ts
/**
 * `createActivitypubMastodonApi` — composes `@dwk/mastodon-api`'s
 * `createMastodonApi` over this package's internal DO seam (mirrors
 * `createSolidPodWebdav`'s *export* shape; the actual data-fetch mechanism
 * follows `mcp-tools.ts`/`syndication.ts`, not solid-pod's in-DO closures —
 * see docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md).
 *
 * @see spec/mastodon-client-api.md
 */

import {
  createMastodonApi,
  decodeRemoteAccountId,
  encodeSnowflake,
  decodeSnowflake,
  type MastodonApiConfig,
  type MastodonApiEnv,
  type MastodonBackend,
  type BackendAccount,
  type BackendPage,
  type BackendPageQuery,
  type BackendEntry,
} from "@dwk/mastodon-api";

import { INTERNAL_HEADERS, type ResolvedConfig } from "./config.js";
import { forwardedConfig } from "./handler.js";
import type { ActivityPubObject } from "./object.js";
import type { JsonValue } from "./as2.js";

/** Options for {@link createActivitypubMastodonApi}. */
export interface ActivitypubMastodonApiOptions {
  readonly config: ResolvedConfig;
  readonly actor: DurableObjectNamespace<ActivityPubObject>;
  /** Everything `MastodonApiConfig` needs except `backend`, which this adapter supplies. */
  readonly mastodonConfig: Omit<MastodonApiConfig, "backend">;
}

interface ClientEntryRow {
  readonly seq: number;
  readonly receivedAt: number;
  readonly activity: Record<string, unknown>;
  readonly relayedBy: string | null;
}

function toBackendEntry(row: ClientEntryRow): BackendEntry {
  return {
    id: encodeSnowflake(row.receivedAt, row.seq),
    activity: row.activity,
    receivedAt: row.receivedAt,
    objectType: typeof row.activity.type === "string" ? row.activity.type : null,
    relayedBy: row.relayedBy,
  };
}

function cursorParams(query: BackendPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit));
  const bound = (snowflake: string | undefined, prefix: string) => {
    if (!snowflake) return;
    const decoded = decodeSnowflake(snowflake);
    if (!decoded) return;
    params.set(`${prefix}_received_at`, String(decoded.receivedAtMs));
    params.set("tie_seq", String(decoded.seqLow));
  };
  bound(query.maxId, "max");
  bound(query.sinceId, "since");
  bound(query.minId, "min");
  return params;
}

/** Build `createActivitypubMastodonApi`'s `MastodonBackend` over the internal DO seam. */
export function createActivitypubMastodonApi(
  options: ActivitypubMastodonApiOptions,
): (
  request: Request,
  env: MastodonApiEnv & { readonly ACTOR: DurableObjectNamespace<ActivityPubObject> },
  ctx: ExecutionContext,
) => Promise<Response> {
  const { config, actor, mastodonConfig } = options;

  const internalHeaders = (): Headers => {
    const headers = new Headers();
    headers.set(INTERNAL_HEADERS.config, JSON.stringify(forwardedConfig(config)));
    headers.set(INTERNAL_HEADERS.internal, "1");
    return headers;
  };
  const stub = () => actor.get(actor.idFromName(config.iris.id));

  const backend: MastodonBackend = {
    async account(): Promise<BackendAccount> {
      const response = await stub().fetch(
        new Request(`${config.iris.id}/__stats`, { headers: internalHeaders() }),
      );
      const stats = response.ok
        ? ((await response.json()) as Record<string, number>)
        : {};
      return {
        counts: {
          followers: stats.followers ?? 0,
          following: stats.following ?? 0,
          statuses: stats.statuses ?? 0,
        },
      };
    },

    async timeline(query: BackendPageQuery): Promise<BackendPage<BackendEntry>> {
      return listEntries("timeline", query);
    },

    async notifications(query: BackendPageQuery): Promise<BackendPage<BackendEntry>> {
      return listEntries("notifications", query);
    },

    async entry(id: string): Promise<BackendEntry | null> {
      const decoded = decodeSnowflake(id);
      if (!decoded) return null;
      const url = new URL(`${config.iris.id}/__client/entry`);
      url.searchParams.set("received_at", String(decoded.receivedAtMs));
      url.searchParams.set("seq_low", String(decoded.seqLow));
      const response = await stub().fetch(new Request(url.toString(), { headers: internalHeaders() }));
      if (!response.ok) return null;
      const row = (await response.json()) as ClientEntryRow;
      return toBackendEntry(row);
    },
  };

  async function listEntries(
    kind: "timeline" | "notifications",
    query: BackendPageQuery,
  ): Promise<BackendPage<BackendEntry>> {
    const url = new URL(`${config.iris.id}/__client/${kind}`);
    for (const [key, value] of cursorParams(query)) url.searchParams.set(key, value);
    const response = await stub().fetch(new Request(url.toString(), { headers: internalHeaders() }));
    if (!response.ok) return { entries: [] };
    const body = (await response.json()) as { items: ClientEntryRow[] };
    return { entries: body.items.map(toBackendEntry) };
  }

  const mastodonHandler = createMastodonApi({ ...mastodonConfig, backend });

  return async (request, env, ctx) => mastodonHandler(request, env, ctx);
}
```

Note: `decodeRemoteAccountId` is imported but unused in this file today —
it's re-exported here only if `accounts/:id` (Task 12) needs it from this
side; if Task 12's implementation only needs it in `@dwk/mastodon-api`
itself (it does — `remoteAccountEntity`/`decodeRemoteAccountId` are both
already package-local to `@dwk/mastodon-api`), remove this unused import
before committing (`pnpm lint` will catch it — `noUnusedLocals`).

- [ ] **Step 3b: Wire the export and dependency**

`packages/activitypub/src/index.ts` — add near the `createActivitypubMcpTools` export:

```ts
export {
  createActivitypubMastodonApi,
  type ActivitypubMastodonApiOptions,
} from "./mastodon-api.js";
```

`packages/activitypub/package.json` — add to `dependencies` (alphabetical, matching the existing list):

```json
    "@dwk/mastodon-api": "workspace:*",
```

`packages/activitypub/CLAUDE.md` — add a line to the file-layout block
(after the `mcp-tools.ts` line):

```
src/mastodon-api.ts # createActivitypubMastodonApi — composes @dwk/mastodon-api's router over the internal __client/* seam (#349)
```

Run `pnpm install` at the repo root after the `package.json` edit so the
workspace link resolves.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/activitypub mastodon-api`
Expected: PASS. Then: `pnpm typecheck && pnpm test --project @dwk/activitypub`

- [ ] **Step 5: Commit**

```bash
git add packages/activitypub/src/mastodon-api.ts packages/activitypub/src/mastodon-api.test.ts \
        packages/activitypub/src/index.ts packages/activitypub/package.json \
        packages/activitypub/CLAUDE.md pnpm-lock.yaml
git commit -m "feat(activitypub,mastodon-api): createActivitypubMastodonApi adapter over the internal __client/* seam"
```

---

## Task 9: Export snowflake + remote-account helpers from `@dwk/mastodon-api`

**Files:**
- Modify: `packages/mastodon-api/src/index.ts`

**Interfaces:**
- Produces: adds `encodeSnowflake`, `decodeSnowflake`, `type
  DecodedSnowflake` (from `./snowflake.js`), `encodeRemoteAccountId`,
  `decodeRemoteAccountId`, `remoteAccountEntity`, `statusEntity`,
  `notificationEntity` (from `./entities.js`) to the public surface — Task
  8's adapter and Task 10/11/12's route handlers both need to import these
  across the package boundary (`@dwk/activitypub` → `@dwk/mastodon-api`).

This is a pure export-list change; no new logic, so it's TDD-light — the
"test" is that Task 8's adapter (already written) typechecks against it.

- [ ] **Step 1: Add exports**

```ts
export {
  encodeSnowflake,
  decodeSnowflake,
  type DecodedSnowflake,
} from "./snowflake.js";
export {
  encodeRemoteAccountId,
  decodeRemoteAccountId,
  remoteAccountEntity,
  statusEntity,
  notificationEntity,
} from "./entities.js";
```

Add this block to `packages/mastodon-api/src/index.ts` right after the
existing `export { mastodonError } from "./errors.js";` line.

- [ ] **Step 2: Verify Task 8 typechecks against the new exports**

Run: `pnpm --filter @dwk/activitypub typecheck`
Expected: no unresolved-import errors for `@dwk/mastodon-api`'s new names
(if Task 8 was implemented before this task, its imports now resolve; if
this task runs first, revisit Task 8's import line against the final names
here).

- [ ] **Step 3: Run the full mastodon-api suite for a sanity check**

Run: `pnpm test --project @dwk/mastodon-api`
Expected: PASS, no change in test count/behavior (pure export addition).

- [ ] **Step 4: Commit**

```bash
git add packages/mastodon-api/src/index.ts
git commit -m "feat(mastodon-api): export snowflake codec and entity-mapping helpers for the activitypub adapter"
```

---

## Task 10: `GET /api/v1/timelines/home`

**Files:**
- Create: `packages/mastodon-api/src/timelines.ts`
- Modify: `packages/mastodon-api/src/handler.ts` (register the route)
- Test: `packages/mastodon-api/src/timelines.test.ts`

**Interfaces:**
- Consumes: `authenticateBearer` (`./auth.js`), `RouteContext`
  (`./handler.js`), `statusEntity` (Task 5), `buildLinkHeader` (Task 7),
  `config.backend` (`MastodonApiConfig.backend`, already optional per
  phase-1's `config.ts:95`).
- Produces: `handleHomeTimeline(ctx: RouteContext): Promise<Response>`,
  registered as `"GET /api/v1/timelines/home"` in `handler.ts`'s `ROUTES`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { api, testEnv, resetDb, registerApp, obtainAccessToken } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

function fakeBackend(entries: unknown[]): MastodonBackend {
  return {
    account: async () => ({ counts: { followers: 0, following: 0, statuses: 0 } }),
    timeline: async () => ({ entries: entries as never }),
    notifications: async () => ({ entries: [] }),
    entry: async () => null,
  };
}

describe("GET /api/v1/timelines/home", () => {
  it("401s without a bearer token", async () => {
    await resetDb();
    const response = await api()(new Request("https://owner.example/api/v1/timelines/home"));
    expect(response.status).toBe(401);
  });

  it("returns mapped statuses with a Link header when authenticated", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const entry = {
      id: encodeSnowflake(1_753_000_000_000, 1),
      receivedAt: 1_753_000_000_000,
      objectType: "Note",
      relayedBy: null,
      activity: {
        type: "Create",
        actor: "https://remote.example/users/alice",
        object: { type: "Note", content: "<p>hi</p>" },
      },
    };
    const cfgWithBackend = { ...(await import("./test-harness.js")).testConfig, backend: fakeBackend([entry]) };
    const response = await api(cfgWithBackend)(
      new Request("https://owner.example/api/v1/timelines/home", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(entry.id);
    expect(response.headers.get("link")).toContain('rel="next"');
  });
});
```

`registerApp`/`obtainAccessToken` already exist in
`packages/mastodon-api/src/test-harness.ts:55-115` — no changes needed
there.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api timelines`
Expected: FAIL — route 404s (unregistered).

- [ ] **Step 3: Implement**

```ts
/** `GET /api/v1/timelines/home` — the inbox-derived home timeline. */

import { authenticateBearer } from "./auth.js";
import { statusEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader } from "./pagination.js";
import { createMastodonStore } from "./store.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

export async function handleHomeTimeline(ctx: RouteContext): Promise<Response> {
  const token = await authenticateBearer(ctx.request, createMastodonStore(ctx.env));
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return Response.json([]);

  const limit = Math.min(
    Math.max(1, Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT),
    ctx.config.pageSize?.max ?? MAX_LIMIT,
  );
  const page = await ctx.config.backend.timeline({
    limit,
    maxId: ctx.url.searchParams.get("max_id") ?? undefined,
    sinceId: ctx.url.searchParams.get("since_id") ?? undefined,
    minId: ctx.url.searchParams.get("min_id") ?? undefined,
  });
  const statuses = page.entries.map((entry) => statusEntity(entry, { baseUrl: ctx.config.baseUrl }));
  const link = buildLinkHeader(ctx.url, {
    firstId: page.entries[0]?.id,
    lastId: page.entries[page.entries.length - 1]?.id,
  });
  const response = Response.json(statuses);
  if (link) response.headers.set("link", link);
  return response;
}
```

Register in `packages/mastodon-api/src/handler.ts`: add
`import { handleHomeTimeline } from "./timelines.js";` and
`["GET /api/v1/timelines/home", handleHomeTimeline],` to the `ROUTES` map
(after the markers entries, before the oauth entries — grouping doesn't
matter functionally, keep it near the other read-surface routes for
readability).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api timelines`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/timelines.ts packages/mastodon-api/src/timelines.test.ts \
        packages/mastodon-api/src/handler.ts
git commit -m "feat(mastodon-api): GET /api/v1/timelines/home"
```

---

## Task 11: `GET /api/v1/notifications`

**Files:**
- Create: `packages/mastodon-api/src/notifications.ts`
- Modify: `packages/mastodon-api/src/handler.ts` (register the route)
- Test: `packages/mastodon-api/src/notifications.test.ts`

**Interfaces:**
- Consumes: same as Task 10, plus `notificationEntity` (Task 6).
- Produces: `handleNotifications(ctx: RouteContext): Promise<Response>`,
  registered as `"GET /api/v1/notifications"`.

Mirrors Task 10 closely enough that the test/implementation are shown in
full rather than by reference (per the "no placeholders" rule — a
`# Similar to Task 10` step is not acceptable).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { api, resetDb, obtainAccessToken, testConfig } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

function fakeBackend(entries: unknown[]): MastodonBackend {
  return {
    account: async () => ({ counts: { followers: 0, following: 0, statuses: 0 } }),
    timeline: async () => ({ entries: [] }),
    notifications: async () => ({ entries: entries as never }),
    entry: async () => null,
  };
}

describe("GET /api/v1/notifications", () => {
  it("401s without a bearer token", async () => {
    await resetDb();
    const response = await api()(new Request("https://owner.example/api/v1/notifications"));
    expect(response.status).toBe(401);
  });

  it("maps a Like row to a favourite notification, dropping unmapped rows", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const like = {
      id: encodeSnowflake(1_753_000_000_010, 1),
      receivedAt: 1_753_000_000_010,
      objectType: null,
      relayedBy: null,
      activity: {
        type: "Like",
        actor: "https://remote.example/users/carol",
        object: "https://owner.example/users/owner/outbox/1",
      },
    };
    const cfg = { ...testConfig, backend: fakeBackend([like]) };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/notifications", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.type).toBe("favourite");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api notifications`
Expected: FAIL — route unregistered.

- [ ] **Step 3: Implement**

```ts
/** `GET /api/v1/notifications` — favourite/reblog/mention only in phase 2 (Follow deferred to #350). */

import { authenticateBearer } from "./auth.js";
import { notificationEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader } from "./pagination.js";
import { createMastodonStore } from "./store.js";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;

export async function handleNotifications(ctx: RouteContext): Promise<Response> {
  const token = await authenticateBearer(ctx.request, createMastodonStore(ctx.env));
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return Response.json([]);

  const limit = Math.min(
    Math.max(1, Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT),
    ctx.config.pageSize?.max ?? MAX_LIMIT,
  );
  const page = await ctx.config.backend.notifications({
    limit,
    maxId: ctx.url.searchParams.get("max_id") ?? undefined,
    sinceId: ctx.url.searchParams.get("since_id") ?? undefined,
    minId: ctx.url.searchParams.get("min_id") ?? undefined,
  });
  const notifications = page.entries
    .map((entry) => notificationEntity(entry, { baseUrl: ctx.config.baseUrl }))
    .filter((n): n is Record<string, unknown> => n !== null);
  const link = buildLinkHeader(ctx.url, {
    firstId: page.entries[0]?.id,
    lastId: page.entries[page.entries.length - 1]?.id,
  });
  const response = Response.json(notifications);
  if (link) response.headers.set("link", link);
  return response;
}
```

Register in `handler.ts`: `import { handleNotifications } from
"./notifications.js";` and `["GET /api/v1/notifications",
handleNotifications],` in `ROUTES`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api notifications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/notifications.ts packages/mastodon-api/src/notifications.test.ts \
        packages/mastodon-api/src/handler.ts
git commit -m "feat(mastodon-api): GET /api/v1/notifications (favourite/reblog/mention)"
```

---

## Task 12: Dynamic-path routing + `GET /api/v1/statuses/:id` and `GET /api/v1/accounts/:id`

**Files:**
- Modify: `packages/mastodon-api/src/handler.ts` (add a small dynamic-route
  fallback after the exact-match `ROUTES` lookup)
- Create: `packages/mastodon-api/src/statuses.ts`
- Modify: `packages/mastodon-api/src/accounts.ts` (add
  `handleGetAccount`)
- Test: `packages/mastodon-api/src/statuses.test.ts`,
  additions to `packages/mastodon-api/src/accounts.test.ts`

**Interfaces:**
- Produces: `handleGetStatus(ctx: RouteContext, id: string):
  Promise<Response>`, `handleGetAccount(ctx: RouteContext, id: string):
  Promise<Response>`. Both take the path parameter as a second argument —
  the router extracts it, per the dynamic-route mechanism below.

`createMastodonApi`'s router (`handler.ts:28-42`) is currently an
exact-match `Map<string, RouteHandler>`. Two new endpoints need one path
parameter each. Rather than a general router rewrite (YAGNI — only two
routes need this in v1), add a small ordered list of dynamic patterns
checked after the exact map misses.

- [ ] **Step 1: Write the failing tests**

`packages/mastodon-api/src/statuses.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { api, resetDb, obtainAccessToken, testConfig } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

describe("GET /api/v1/statuses/:id", () => {
  it("404s for an unknown id", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const backend: MastodonBackend = {
      account: async () => ({ counts: { followers: 0, following: 0, statuses: 0 } }),
      timeline: async () => ({ entries: [] }),
      notifications: async () => ({ entries: [] }),
      entry: async () => null,
    };
    const response = await api({ ...testConfig, backend })(
      new Request(`https://owner.example/api/v1/statuses/${encodeSnowflake(1, 1)}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("200s with the mapped Status for a known id", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const id = encodeSnowflake(1_753_000_000_020, 1);
    const backend: MastodonBackend = {
      account: async () => ({ counts: { followers: 0, following: 0, statuses: 0 } }),
      timeline: async () => ({ entries: [] }),
      notifications: async () => ({ entries: [] }),
      entry: async (requested) =>
        requested === id
          ? {
              id,
              receivedAt: 1_753_000_000_020,
              objectType: "Note",
              relayedBy: null,
              activity: {
                type: "Create",
                actor: "https://remote.example/users/alice",
                object: { type: "Note", content: "<p>hi</p>" },
              },
            }
          : null,
    };
    const response = await api({ ...testConfig, backend })(
      new Request(`https://owner.example/api/v1/statuses/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe(id);
  });
});
```

Add to `packages/mastodon-api/src/accounts.test.ts`:

```ts
describe("GET /api/v1/accounts/:id", () => {
  it("returns the owner account for the owner id", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const response = await api()(
      new Request("https://owner.example/api/v1/accounts/1", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { username: string }).username).toBe("owner");
  });

  it("re-synthesizes a remote account from its encoded id, no backend call", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const { encodeRemoteAccountId } = await import("./entities.js");
    const id = encodeRemoteAccountId("https://remote.example/users/alice");
    const response = await api()(
      new Request(`https://owner.example/api/v1/accounts/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { username: string }).username).toBe("alice");
  });

  it("404s for an id that decodes to neither the owner nor a valid remote IRI", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const response = await api()(
      new Request("https://owner.example/api/v1/accounts/not-a-real-id", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --project @dwk/mastodon-api statuses`
Run: `pnpm test --project @dwk/mastodon-api accounts`
Expected: FAIL — both new endpoints 404 (unrouted) or don't exist.

- [ ] **Step 3: Implement the dynamic-route mechanism**

In `packages/mastodon-api/src/handler.ts`, add after the `ROUTES` map
definition and before `CORS_HEADERS`:

```ts
type DynamicRouteHandler = (ctx: RouteContext, id: string) => Promise<Response>;

/** `METHOD` + a regex capturing the one path parameter these routes need. */
const DYNAMIC_ROUTES: readonly [string, RegExp, DynamicRouteHandler][] = [
  ["GET", /^\/api\/v1\/statuses\/([^/]+)$/, (ctx, id) => handleGetStatus(ctx, id)],
  ["GET", /^\/api\/v1\/accounts\/([^/]+)$/, (ctx, id) => handleGetAccount(ctx, id)],
];
```

Add the imports (`handleGetStatus` from `./statuses.js`, `handleGetAccount`
from `./accounts.js`) to the existing import block at the top of the file.

In `createMastodonApi`'s returned function, after the exact-match `route`
lookup misses and before falling through to `recordNotFound()`:

```ts
    const route = ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (route) {
      return withCors(await route({ config, env, request, url }));
    }
    for (const [method, pattern, dynamicHandler] of DYNAMIC_ROUTES) {
      if (request.method.toUpperCase() !== method) continue;
      const match = pattern.exec(url.pathname);
      if (match?.[1]) {
        return withCors(await dynamicHandler({ config, env, request, url }, decodeURIComponent(match[1])));
      }
    }
    return withCors(recordNotFound());
```

- [ ] **Step 3b: Implement `handleGetStatus`**

`packages/mastodon-api/src/statuses.ts`:

```ts
/** `GET /api/v1/statuses/:id`. */

import { authenticateBearer } from "./auth.js";
import { statusEntity } from "./entities.js";
import { accountRequired, invalidToken, recordNotFound } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

export async function handleGetStatus(ctx: RouteContext, id: string): Promise<Response> {
  const token = await authenticateBearer(ctx.request, createMastodonStore(ctx.env));
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return recordNotFound();

  const entry = await ctx.config.backend.entry(id);
  if (!entry) return recordNotFound();
  return Response.json(statusEntity(entry, { baseUrl: ctx.config.baseUrl }));
}
```

- [ ] **Step 3c: Implement `handleGetAccount`**

Add to `packages/mastodon-api/src/accounts.ts` (after the existing
`handleVerifyAccountCredentials`):

```ts
import { OWNER_ACCOUNT_ID } from "./config.js";
import {
  credentialAccountEntity,
  decodeRemoteAccountId,
  remoteAccountEntity,
} from "./entities.js";
import { recordNotFound } from "./errors.js";

/**
 * `GET /api/v1/accounts/:id` — the owner (config-derived) or a remote
 * account re-synthesized from its reversibly-encoded id, no backend call
 * (spec/mastodon-client-api.md: "no enumeration... no outbound fetches").
 */
export async function handleGetAccount(ctx: RouteContext, id: string): Promise<Response> {
  const token = await authenticateBearer(ctx.request, createMastodonStore(ctx.env));
  if (!token) return invalidToken();

  if (id === OWNER_ACCOUNT_ID) {
    const counts = ctx.config.backend
      ? (await ctx.config.backend.account()).counts
      : { followers: 0, following: 0, statuses: 0 };
    // /accounts/:id returns a plain Account, not the verify_credentials
    // CredentialAccount — credentialAccountEntity's extra `source` field is
    // harmless extra data here (Mastodon clients ignore unknown fields), so
    // it's reused rather than duplicating the whole builder for one field.
    return Response.json(credentialAccountEntity(ctx.config, counts));
  }

  const actorIri = decodeRemoteAccountId(id);
  if (!actorIri) return recordNotFound();
  return Response.json(remoteAccountEntity(actorIri));
}
```

Add the matching imports (`authenticateBearer`, `invalidToken`,
`createMastodonStore`, `RouteContext`) at the top if not already present —
`accounts.ts` already imports most of these for
`handleVerifyAccountCredentials`; only add what's missing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --project @dwk/mastodon-api statuses`
Run: `pnpm test --project @dwk/mastodon-api accounts`
Expected: PASS. Then the full package suite:
`pnpm test --project @dwk/mastodon-api`

- [ ] **Step 5: Commit**

```bash
git add packages/mastodon-api/src/handler.ts packages/mastodon-api/src/statuses.ts \
        packages/mastodon-api/src/statuses.test.ts packages/mastodon-api/src/accounts.ts \
        packages/mastodon-api/src/accounts.test.ts
git commit -m "feat(mastodon-api): GET /api/v1/statuses/:id and GET /api/v1/accounts/:id"
```

---

## Task 13: Mount `@dwk/mastodon-api` on the conformance target

**Files:**
- Modify: `packages/conformance-target/package.json` (add dependency)
- Modify: `packages/conformance-target/src/config.ts` (add
  `mastodonApi`/`mastodonConfig` config + `MastodonApiEnv` binding)
- Modify: `packages/conformance-target/src/mounts.ts` (mount the handler)
- Modify: `packages/conformance-target/src/approval.ts` (extend the
  existing consent hook, or add a matching one, for
  `ApproveMastodonAuthorization` — reuse the IndieAuth consent pattern
  already there)
- Test: whatever this package's existing smoke-test convention is (check
  for a `*.test.ts` in `packages/conformance-target/src` first — if none
  exists, this task's verification step is `pnpm build` +
  `pnpm --filter @dwk/conformance-target typecheck` plus a manual
  `wrangler dev` smoke check, matching how solid-pod's webdav mount was
  verified when it landed, per its own PR)

**Interfaces:**
- Consumes: `createActivitypubMastodonApi` (Task 8),
  `ActivitypubMastodonApiOptions`.
- Produces: `/api/v1/*`, `/api/v2/*`, `/oauth/authorize`, `/oauth/token`,
  `/oauth/revoke` now answer on the conformance target, backed by the real
  actor DO — closing the pixelfed-qa step-4 gap.

- [ ] **Step 1: Read `packages/conformance-target/src/approval.ts` and
  `config.ts` in full before writing this task's code** (they weren't
  covered by phase 2's research pass — read them now to match the existing
  `approveAuthorization`/`ApproveIndieAuthAuthorization` pattern exactly,
  since inventing a divergent shape here would be a real defect, not just
  style). Confirm: does `approval.ts` already export a reusable owner-auth
  check (e.g. a shared password/session check) that
  `ApproveMastodonAuthorization` can call into, or does it need its own
  copy? Prefer reuse if the existing code makes it easy; don't force a
  shared abstraction if the two hooks' auth flows have diverged.

- [ ] **Step 2: Add the D1 binding and dependency**

`packages/conformance-target/package.json`:

```json
    "@dwk/mastodon-api": "workspace:*",
```

(alphabetical in the existing `dependencies` block.) Run `pnpm install` at
the repo root afterward.

Confirm (or add) an `AUTH_DB` D1 binding in this package's `wrangler.jsonc`
— check whether `indieauth`/`micropub` already declare `AUTH_DB` there
(the design doc says it's the same shared binding name); if so, no new D1
binding is needed, `@dwk/mastodon-api`'s store just gets its own
`mastodon_`-prefixed tables in the same database.

- [ ] **Step 3: Wire config in `config.ts`**

Add a `mastodonApi: ActivitypubMastodonApiOptions["mastodonConfig"]` (or
equivalent) entry to `configsFor(env)`'s returned object, following this
file's existing pattern exactly for how `c.activitypub` is built (same
`baseUrl`, `USERNAME` constant, etc. this file already threads through for
`c.activitypub`). Instance metadata (`title`/`description`) can reuse
whatever the existing home page / actor profile already advertises for the
conformance actor — check `home.ts` for the existing copy to stay
consistent rather than inventing new instance-description text.

- [ ] **Step 4: Mount in `mounts.ts`**

Add, following the exact pattern of the existing `@dwk/webdav (litmus pod
door)` entry (`mounts.ts:128-132`):

```ts
    {
      name: "@dwk/mastodon-api",
      matches: (u) =>
        u.pathname.startsWith("/api/v1/") ||
        u.pathname.startsWith("/api/v2/") ||
        u.pathname === "/oauth/authorize" ||
        u.pathname === "/oauth/token" ||
        u.pathname === "/oauth/revoke",
      handler: createActivitypubMastodonApi({
        config: /* the same ResolvedConfig instance c.activitypub already resolves to, or a fresh resolveConfig(c.activitypubRaw) call — match whatever config.ts's structure ends up being from Step 3 */,
        actor: env.ACTOR,
        mastodonConfig: c.mastodonApi,
      }),
    },
```

Add the `createActivitypubMastodonApi` import from `@dwk/activitypub` to
the top import block (it's already imported for `createActivityPub`; add
the new named export to the same `import { ... } from "@dwk/activitypub"`
line rather than a second import statement).

**Route-ordering note:** `/oauth/authorize`/`/oauth/token`/`/oauth/revoke`
here are distinct paths from `@dwk/indieauth`'s `/authorize`/`/token`/
`/revocation` mount above it in the table (no leading `/oauth/` on the
IndieAuth ones) — confirm this by re-reading the `@dwk/indieauth` mount
entry (`mounts.ts:76-84`) before assuming no collision; the design doc
states they don't overlap, but verify against the actual mounted paths in
this file, not just the design doc's claim.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @dwk/conformance-target typecheck`
Run: `pnpm --filter @dwk/conformance-target build`
Expected: both succeed with no errors.

If this package has no existing test file to extend, add a minimal smoke
test (`packages/conformance-target/src/mounts.test.ts`, only if a sibling
pattern for testing `mounts.ts` doesn't already exist elsewhere in the
package — check first) asserting `GET /api/v1/instance` on the built mount
table returns `200`. If a test harness for this package already exists,
follow its established pattern instead of inventing a new one.

- [ ] **Step 6: Commit**

```bash
git add packages/conformance-target/package.json packages/conformance-target/src/config.ts \
        packages/conformance-target/src/mounts.ts packages/conformance-target/src/approval.ts \
        pnpm-lock.yaml
git commit -m "feat(conformance-target): mount @dwk/mastodon-api (/api/, /oauth/*)"
```

---

## Task 14: Conformance runbook + changesets

**Files:**
- Create: `conformance/mastodon-client-qa.md`
- Create: `.changeset/mastodon-api-phase-2.md`
- Modify: `spec/packages/mastodon-api.md` (move the phase-2 items from
  "not yet implemented" to a filled-in roster, and add the endpoint/field
  tables the design doc deferred to implementation time)
- Modify: `packages/mastodon-api/CLAUDE.md` (file layout table — add
  `snowflake.ts`, `sanitize.ts`, `pagination.ts`, `timelines.ts`,
  `notifications.ts`, `statuses.ts`)

**Interfaces:** None — documentation/process only.

- [ ] **Step 1: Write `conformance/mastodon-client-qa.md`**

Model it directly on `conformance/pixelfed-qa.md`'s structure (Environment
table, numbered Procedure steps with Pass/Fail checkboxes, Result table,
Recording-the-result section, Troubleshooting). Cover, per
`spec/mastodon-client-api.md`'s Conformance section:

```markdown
# Mastodon-compatible client API — QA runbook

Manual acceptance test for `@dwk/mastodon-api` phase 2 (issue #349),
companion to [`pixelfed-qa.md`](./pixelfed-qa.md) — this is the read path
that runbook's step 4 could only confirm indirectly.

## Scope

- **In scope:** app registration, OAuth round-trip, `verify_credentials`,
  home timeline rendering (media, content warning, alt text), notifications
  rendering a real like + reply.
- **Out of scope:** Follow notifications (deferred to phase 3/#350 — see
  `docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md`),
  posting/any write (non-goal), streaming (non-goal).

## Environment

|                       |                                                          |
| --------------------- | -------------------------------------------------------- |
| Target instance       | `https://conformance.dwk.io`                              |
| Test client 1         | Pixelfed's own app                                        |
| Test client 2         | Tusky                                                      |

## Procedure

### Step 1 — Register and log in from each client

1. In the client, add a new account with instance `conformance.dwk.io`.
2. Complete the OAuth consent flow.
3. Confirm the client shows the owner's profile (`verify_credentials`).

- [ ] **Pass** (Pixelfed app) — [ ] **Pass** (Tusky)
- [ ] **Fail** — note what happened: ________________________________

### Step 2 — Home timeline renders

Prerequisite: the actor has at least one received `Create`/`Announce` in
its inbox (reuse pixelfed-qa's follow + publish steps against a second
test account, or any existing federated content).

- [ ] **Pass** — timeline renders with media/CW/alt text as expected
- [ ] **Fail** — note what's missing: ________________________________

### Step 3 — Notifications render the pixelfed-qa step-4 like + reply

Using the same Pixelfed test account from `pixelfed-qa.md` step 4 (which
liked and replied to a post), confirm both now render as notifications:

- [ ] **Pass** — the `Like` renders as a favourite notification
- [ ] **Pass** — the reply renders as a mention notification
- [ ] **Fail** — note what's missing: ________________________________

## Result

|                             |     |
| --------------------------- | --- |
| Overall result               | ☐ Passing / ☐ Failing |
| Run date                     |     |
| Tester                       |     |
| Notes / follow-ups           |     |

## Recording the result

Once every step passes for a client, record it in `conformance/status.json`:

    packages["@dwk/mastodon-api"].suites["mastodon-client-api"].targets.pixelfed-app
      = { "status": "passing", "report": null, "lastRun": "<ISO-8601 timestamp>" }

(similarly for `.targets.tusky`). Leave `"pending"` if any step fails.
```

(The exact prose can be refined during implementation, but the four
sections above — Scope, Environment, Procedure with checkboxes, Result +
Recording — are required, matching `pixelfed-qa.md`'s structure exactly.)

- [ ] **Step 2: Write the changeset**

`.changeset/mastodon-api-phase-2.md`:

```markdown
---
"@dwk/mastodon-api": minor
"@dwk/activitypub": minor
---

Phase 2 of the Mastodon-compatible client API (#349): the DO-backed read
surface. `@dwk/activitypub` gains additive internal routes
(`__client/timeline`, `__client/notifications`, `__client/entry`) and one
new export, `createActivitypubMastodonApi`, composing `@dwk/mastodon-api`'s
router over them (mirrors the `createSolidPodWebdav` precedent).
`@dwk/mastodon-api` gains `GET /api/v1/timelines/home`, `GET
/api/v1/notifications`, `GET /api/v1/statuses/:id`, `GET
/api/v1/accounts/:id`, Mastodon-shaped snowflake IDs, RFC 8288 `Link`
pagination, and the AS2 → Mastodon entity mapping (including FEP-1b12
reblog provenance for group-relayed posts). Follow notifications are
deferred to phase 3 (#350) — inbound `Follow` activities aren't currently
stored in a form this read surface can classify; see the phase-2
implementation notes for why.
```

- [ ] **Step 3: Update `spec/packages/mastodon-api.md`**

Replace the "Phase 2/3 (not yet implemented)" section
(`spec/packages/mastodon-api.md:124-135`) with a filled-in roster
mirroring the existing "Endpoint roster (phase 1)" / "Entity fields
emitted (phase 1)" sections' format (`spec/packages/mastodon-api.md:33-114`)
— list the four new endpoints, the `MastodonBackend` seam, the snowflake ID
scheme, and explicitly the Follow-notification deferral. Match this file's
existing table style rather than prose.

- [ ] **Step 4: Update `packages/mastodon-api/CLAUDE.md`**

Add to the file-layout block:

```
src/snowflake.ts    # Mastodon-shaped snowflake ID codec
src/sanitize.ts      # allowlist HTML sanitizer for inbound status content
src/pagination.ts    # RFC 8288 Link header builder
src/timelines.ts     # GET /api/v1/timelines/home
src/notifications.ts # GET /api/v1/notifications
src/statuses.ts      # GET /api/v1/statuses/:id
```

- [ ] **Step 5: Verify the full monorepo gate**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. This is CI's exact sequence
(`.github/workflows/ci.yml`) — matching it locally now avoids a
red-CI surprise on the PR.
Also run: `pnpm catalog:check` and `pnpm release:gate` (or `--report`) to
confirm `conformance/status.json`'s new/existing `mastodon-client-api`
suite entries still validate against the schema after any edits in this
task.

- [ ] **Step 6: Commit**

```bash
git add conformance/mastodon-client-qa.md .changeset/mastodon-api-phase-2.md \
        spec/packages/mastodon-api.md packages/mastodon-api/CLAUDE.md
git commit -m "docs(mastodon-api,activitypub): phase 2 conformance runbook, changeset, and spec updates"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** every phase-2 checklist item from issue #349 maps to a
  task above except two the design doc doesn't actually require code for:
  the catalog entry (`catalog.json`'s `mastodon-api` worker) is **already
  fully specified** as of phase 1 — confirmed by reading it directly; no
  task needed. `conformance/status.json`'s `mastodon-client-api` suite
  scaffold is likewise already present (`pending`, with `pixelfed-app`/
  `tusky` targets) — Task 14 only points at how to flip it after a real
  manual run, it doesn't need to create the schema entries.
- **Known follow-up gaps intentionally left in this plan, not silently
  dropped:** (1) Follow notifications — phase 3/#350, confirmed decision.
  (2) `in_reply_to_id` on mapped `Status` entities is always `null` in
  phase 2 (Task 5's note) — full reply-threading to a *local* snowflake
  isn't needed for the acceptance bar (a reply shows up as a mention
  notification either way) but is worth flagging in the PR description as
  a known v1 gap, not a bug.
- **Type consistency check performed:** `BackendEntry`/`BackendPage`/
  `BackendPageQuery`/`MastodonBackend` names and shapes match `backend.ts`
  exactly as already shipped in phase 1 — no renaming needed across tasks.
  `ClientEntryRow` (Task 8) is a new, adapter-internal wire shape distinct
  from `BackendEntry` — Task 8's `toBackendEntry` is the one conversion
  point; don't let a later task reintroduce a second shape for the same
  DO-route response.
