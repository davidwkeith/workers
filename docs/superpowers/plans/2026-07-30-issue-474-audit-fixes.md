# Issue #474 Audit Fixes — HIGH + MEDIUM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 5 HIGH and 17 MEDIUM findings from the Workers-best-practices audit tracked in [issue #474](https://github.com/davidwkeith/workers/issues/474) — LOW findings are explicitly out of scope for this plan. Each finding is an independent, separately-committable bug fix in its own package; there is no shared feature or migration binding them together beyond the audit that found them.

**Architecture:** No architectural change. Each task patches one existing file (occasionally two: an implementation file plus its `config.ts`) inside one existing package, following that package's established conventions (verified against current `HEAD`, commit `b244212` — the original audit's line numbers had drifted and were re-derived task-by-task).

**Tech Stack:** TypeScript (strict), Vitest (`@cloudflare/vitest-pool-workers` for Workers-runtime packages), pnpm workspaces, Changesets.

## Global Constraints

- **ESM-only, TypeScript strict.** Use `import type` for type-only imports; prefix deliberately-unused vars with `_`.
- **No silent degradation.** A missing required Cloudflare binding must throw at first request (already true everywhere touched here — do not weaken it).
- **Config is injected, never read from global environment** (composition contract) — every fix stays inside the existing factory/config shape.
- **Commit messages:** Conventional Commits, `<type>(<scope>): <subject>` — lowercase type, subject not capitalized, scope = package name minus `@dwk/` prefix. Every task in this plan uses `fix(<pkg>): <subject>`.
- **Changesets:** every touched *publishable* package (i.e. not `examples/deploy-to-cloudflare`, which is `"private": true`) gets a `patch` changeset in the same commit as its fix, written directly as a file (do not run the interactive `pnpm changeset` prompt) at `.changeset/<slug>.md`:
  ```markdown
  ---
  "@dwk/<pkg>": patch
  ---

  <One paragraph, present tense, describing the fix and why it matters.>
  ```
- **Test targeting:** `pnpm test --project @dwk/<pkg>` for a package's suite; add `<filename-substring>` or `-t "<test name>"` to scope further. Always pass `--project` — a bare filter errors against non-matching projects.
- **Local CI parity:** lint → `format:check` → typecheck → build → test must all pass; this plan's commit steps only run the scoped test, but assume a final full local CI pass before opening a PR (out of scope for this plan's steps — call out to the user).
- **No comments explaining WHAT** — only WHY, and only where the fix's reasoning isn't obvious from the diff (matches this repo's existing style, visible in every snippet quoted below).
- **`crypto.subtle.timingSafeEqual`** is a real, synchronous, Workers-only `SubtleCrypto` extension (confirmed via `developers.cloudflare.com/workers/runtime-apis/web-crypto` and the worked example at `developers.cloudflare.com/workers/examples/protect-against-timing-attacks`). It **throws on unequal-length input**. Cloudflare's own documented safe pattern — used identically in every timing-safe-equal task below — is:
  ```ts
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  const isEqual = lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
  ```
  Do **not** early-`return false` on a length mismatch — that reintroduces exactly the timing leak being fixed. This keeps every affected function **synchronous** (no `async`/`await` ripple to call sites).

---

### Task 1: webauthn — cap CBOR reader recursion depth (HIGH)

**Files:**
- Modify: `packages/webauthn/src/cbor.ts:59-99` (`Reader.readItem`)
- Test: `packages/webauthn/src/cbor.test.ts`

**Interfaces:**
- Consumes: existing `CborError` (exported, `cbor.ts:35`, `class CborError extends Error {}`), existing `decodeFirst(bytes, start = 0)` (unchanged signature).
- Produces: `Reader.readItem` gains an internal `depth` parameter (default `0`) — not part of any public API, so no downstream task depends on this signature.

- [ ] **Step 1: Write the failing test**

Add to `packages/webauthn/src/cbor.test.ts` (mirrors the existing `toThrow(CborError)` pattern already used in that file):

```ts
it("throws CborError on CBOR nested past the depth limit", () => {
  // Build 40 nested single-element arrays: [[[[...]]]] — each level is a
  // major-type-4 array header `0x81` (array, length 1) followed by its child.
  const DEPTH = 40;
  const bytes = new Uint8Array(DEPTH + 1);
  bytes.fill(0x81, 0, DEPTH); // 40 "array of length 1" headers
  bytes[DEPTH] = 0x00; // innermost item: unsigned integer 0
  expect(() => decodeFirst(bytes)).toThrow(CborError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/webauthn cbor -t "depth limit"`
Expected: FAIL — either a `RangeError: Maximum call stack size exceeded` (the actual DoS) or, if the runtime tolerates 40 frames, no throw at all (assertion failure). Either way, not the expected `CborError`.

- [ ] **Step 3: Implement the depth limit**

```ts
// cbor.ts
class Reader {
  offset: number;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  /** WebAuthn's deepest real structure (COSE key inside authData) needs 2-3
   * levels; 32 is generous headroom without letting a crafted attestation
   * object stack-overflow the Worker. */
  static readonly MAX_DEPTH = 32;

  constructor(bytes: Uint8Array, start: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
  }

  readItem(depth = 0): CborValue {
    if (depth > Reader.MAX_DEPTH) {
      throw new CborError("CBOR nesting exceeds maximum depth");
    }
    const initial = this.#byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0: // unsigned integer
        return this.#argument(info);
      case 1: {
        // negative integer: encodes -(n + 1)
        const n = this.#argument(info);
        return typeof n === "bigint" ? -(n + 1n) : -(n + 1);
      }
      case 2: // byte string
        return this.#bytesOfLength(this.#lengthArgument(info));
      case 3: // text string
        return new TextDecoder().decode(
          this.#bytesOfLength(this.#lengthArgument(info)),
        );
      case 4: {
        // array
        const len = this.#lengthArgument(info);
        const items: CborValue[] = [];
        for (let i = 0; i < len; i++) items.push(this.readItem(depth + 1));
        return items;
      }
      case 5: {
        // map
        const len = this.#lengthArgument(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < len; i++) {
          const key = this.readItem(depth + 1);
          map.set(key, this.readItem(depth + 1));
        }
        return map;
      }
      default:
        // Tags (6) and simple/float (7) are not used by the WebAuthn subset.
        throw new CborError(`unsupported CBOR major type ${major}`);
    }
  }
```

`decodeFirst` is unaffected — `reader.readItem()` still defaults `depth` to `0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/webauthn cbor`
Expected: PASS, including all pre-existing `cbor.test.ts` cases (the depth check only rejects nesting past 32 levels, never legitimate WebAuthn structures).

- [ ] **Step 5: Changeset + commit**

Create `.changeset/webauthn-cbor-depth-limit.md`:
```markdown
---
"@dwk/webauthn": patch
---

Cap the CBOR decoder's recursion depth at 32 levels. A crafted `attestationObject`
with deeply nested arrays/maps could previously stack-overflow the Worker
(denial of service); it now throws `CborError` instead.
```

```bash
git add packages/webauthn/src/cbor.ts packages/webauthn/src/cbor.test.ts .changeset/webauthn-cbor-depth-limit.md
git commit -m "fix(webauthn): cap CBOR reader recursion depth"
```

---

### Task 2: webauthn — wrap ceremony dispatch in try/catch (HIGH)

**Files:**
- Modify: `packages/webauthn/src/rp.ts:82-101` (`WebAuthnObject.fetch`)
- Modify: `packages/webauthn/src/handler.ts:127-161` (`createWebAuthn`'s returned handler)
- Test: `packages/webauthn/src/index.test.ts`, `packages/webauthn/src/rp.test.ts` (or `pod`-equivalent DO test file for this package — confirm the exact filename with `ls packages/webauthn/src/*.test.ts` before writing; use whichever already exercises `WebAuthnObject` directly)

**Interfaces:**
- Consumes: existing `rejected(event: WebAuthnLogEvent, reason: VerifyFailureReason | string): Response` (`rp.ts:468-477`), existing `WebAuthnLogEvent.RegisterRejected` / `.AuthenticateRejected` (`log.ts`), existing `emit(config, level, event, fields?)` (`handler.ts:52-60`).
- Produces: no new exports — only closes the two unguarded call chains the finding names (Task 1 depends on this defense-in-depth existing, but does not require it — Task 1's fix is what actually prevents the stack overflow; this task ensures *any other* future parse failure fails safe too).

- [ ] **Step 1: Write the failing test**

Add to whichever test file exercises `createWebAuthn` end-to-end (e.g. `packages/webauthn/src/index.test.ts`), simulating an internal throw by posting a body that survives JSON parsing but breaks a downstream assumption — reuse the existing `post()`/harness helper already in that file:

```ts
it("returns a structured 500 instead of throwing when verification throws unexpectedly", async () => {
  const handler = createWebAuthn({ rpId: "example.com", rpName: "Example" });
  const env = /* existing test env harness from this file */;
  // A body whose attestationObject is syntactically valid base64url but whose
  // decoded bytes are CBOR nested past the Task-1 depth limit — this is the
  // simplest reliable way to force an unexpected throw deep in the DO's
  // dispatch without hand-building a second failure mode.
  const deepArray = new Uint8Array(40).fill(0x81);
  const res = await handler(
    post("/register/verify", {
      id: "AA",
      rawId: "AA",
      response: {
        clientDataJSON: btoa(JSON.stringify({ type: "webauthn.create", challenge: "x", origin: "https://example.com" })),
        attestationObject: bytesToBase64url(deepArray),
      },
      type: "public-key",
    }),
    env,
  );
  expect(res.status).not.toBe(500 /* unhandled */);
  const body = await res.json();
  expect(body).toHaveProperty("error");
});
```

(Adjust the exact request-body shape to match this file's existing `post()`/fixture helpers — read the file first and reuse its established fixture builder rather than hand-rolling a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/webauthn index -t "unexpected"`
Expected: FAIL — the test harness reports an unhandled rejection / thrown error instead of a `Response`, since Task 1 already prevents the stack overflow but nothing yet catches the resulting `CborError` (or any other future throw) inside dispatch.

- [ ] **Step 3: Wrap the DO's ceremony dispatch (`rp.ts`)**

```ts
// rp.ts — WebAuthnObject
  override async fetch(request: Request): Promise<Response> {
    const op = request.headers.get(INTERNAL_HEADERS.op);
    const config = this.#readConfig(request);
    const now = Number(request.headers.get(INTERNAL_HEADERS.now)) || Date.now();
    const body = await readJsonObject(request);
    if (config === null) return badRequest("missing config");

    try {
      switch (op) {
        case "register/options":
          return await this.#registerOptions(config, now, body);
        case "register/verify":
          return await this.#registerVerify(config, now, body);
        case "authenticate/options":
          return await this.#authenticateOptions(config, now, body);
        case "authenticate/verify":
          return await this.#authenticateVerify(config, now, body);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      // A parse/verification failure that escapes the normal `reject(...)`
      // paths (e.g. a malformed CBOR structure) must still answer the
      // package's structured `{error}` contract instead of an unhandled
      // exception reaching the Workers runtime.
      console.error("@dwk/webauthn: unexpected ceremony error", error);
      const event = op?.startsWith("register/")
        ? WebAuthnLogEvent.RegisterRejected
        : WebAuthnLogEvent.AuthenticateRejected;
      return rejected(event, "internal_error");
    }
  }
```

- [ ] **Step 4: Wrap the front door's DO invocation (`handler.ts`), defense in depth**

```ts
// handler.ts — createWebAuthn's returned handler, replacing the tail
    // One Durable Object per relying party, keyed by the rpId (no sharding).
    const id = env.WEBAUTHN.idFromName(resolved.rpId);
    let response: Response;
    try {
      response = await env.WEBAUTHN.get(id).fetch(
        internalRequest(request, resolved, op),
      );
    } catch (error) {
      console.error("@dwk/webauthn: DO invocation failed", error);
      const rejectedEvent = op.startsWith("register/")
        ? WebAuthnLogEvent.RegisterRejected
        : WebAuthnLogEvent.AuthenticateRejected;
      emit(resolved, "warn", rejectedEvent, { reason: "internal_error" });
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return logOutcome(resolved, response);
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --project @dwk/webauthn`
Expected: PASS (full package suite — this touches the shared dispatch path for all four ceremony steps, so run the whole package, not just the new test).

- [ ] **Step 6: Changeset + commit**

```markdown
---
"@dwk/webauthn": patch
---

Wrap ceremony dispatch (both the per-relying-party Durable Object and the
front door's invocation of it) in try/catch. A parse or verification failure
that previously escaped as an unhandled exception now returns the package's
structured `{error}` JSON contract.
```

```bash
git add packages/webauthn/src/rp.ts packages/webauthn/src/handler.ts packages/webauthn/src/index.test.ts .changeset/webauthn-error-contract.md
git commit -m "fix(webauthn): return structured errors instead of throwing on ceremony failures"
```

---

### Task 3: webauthn — timing-safe challenge comparison (MEDIUM)

**Files:**
- Modify: `packages/webauthn/src/encoding.ts` (add helper near `bytesEqual`, line ~46)
- Modify: `packages/webauthn/src/verify.ts:224-229` (`checkClientData`) and its import block (`verify.ts:29-35`)
- Test: `packages/webauthn/src/verify.test.ts`

**Interfaces:**
- Consumes: existing `utf8ToBytes(input: string): Uint8Array` (`encoding.ts:61-63`).
- Produces: new export `timingSafeEqual(a: string, b: string): boolean` from `encoding.ts` — synchronous, so `checkClientData`'s signature and every caller of it (`verifyRegistration`, `verifyAuthentication`) needs **no** change.

- [ ] **Step 1: Write the failing test**

Add to `packages/webauthn/src/verify.test.ts` near the existing "rejects a challenge mismatch" cases:

```ts
it("rejects a same-length, different-content challenge without leaking length via early exit", () => {
  // A same-length mismatch is the case a naive `!==` string compare and a
  // proper constant-time compare both reject — this asserts behavior, not
  // timing, but guards against a regression to the old `!==` form.
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: bytesToBase64url(new TextEncoder().encode("AAAAAAAAAAAAAAAA")),
      origin: "https://example.com",
    }),
  );
  const result = checkClientData(
    clientDataJSON,
    "webauthn.get",
    bytesToBase64url(new TextEncoder().encode("BBBBBBBBBBBBBBBB")),
    ["https://example.com"],
  );
  expect(result).toBe("challenge_mismatch");
});
```

(`checkClientData` is not currently exported — check whether `verify.test.ts` already imports it directly or only exercises it via `verifyRegistration`/`verifyAuthentication`; if it's not exported, drive this same assertion through `verifyRegistration` with a mismatched `expectedChallenge`, matching the file's existing test style at the lines the research noted, ~106 and ~248.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/webauthn verify -t "leaking length"`
Expected: PASS already (this specific case passes even with the old `!==`) — this step confirms the *new* helper doesn't change observable behavior for the equal-length case before wiring it in; the real regression guard is Step 4's full-suite run.

- [ ] **Step 3: Add the helper and use it**

```ts
// encoding.ts — after bytesEqual
/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Unlike `bytesEqual`, this must not
 * short-circuit on a length mismatch (that itself leaks the length via
 * timing) — compare the value against itself instead, per Cloudflare's
 * documented safe pattern.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = utf8ToBytes(a);
  const bytesB = utf8ToBytes(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}
```

```ts
// verify.ts — import block
import {
  bytesEqual,
  bytesToBase64url,
  bytesToUtf8,
  normalizeBase64url,
  sha256,
  timingSafeEqual,
} from "./encoding.js";
```

```ts
// verify.ts — checkClientData
  if (
    !timingSafeEqual(
      normalizeBase64url(clientData.challenge),
      normalizeBase64url(expectedChallenge),
    )
  ) {
    return "challenge_mismatch";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/webauthn`
Expected: PASS (full package suite — confirms no regression in either registration or authentication ceremonies, both of which call `checkClientData`).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/webauthn": patch
---

Compare the WebAuthn challenge with a constant-time byte comparison
(`crypto.subtle.timingSafeEqual`) instead of a plain string `!==`, closing a
timing side channel on challenge verification.
```

```bash
git add packages/webauthn/src/encoding.ts packages/webauthn/src/verify.ts packages/webauthn/src/verify.test.ts .changeset/webauthn-timing-safe-challenge.md
git commit -m "fix(webauthn): compare challenge with constant-time byte comparison"
```

---

### Task 4: solid-pod — WAC-filter the WebSocket broadcast (HIGH)

**Files:**
- Modify: `packages/solid-pod/src/pod.ts:210-238` (`fetch`, move config/agent extraction above the WS branch)
- Modify: `packages/solid-pod/src/pod.ts:1584-1636` (`#handleWebSocketUpgrade`, `#broadcast`)
- Modify: `packages/solid-pod/src/pod.ts` — all 11 `#broadcast(...)` call sites (lines ~636, 684-685, 786, 844, 1169, 1187, 1219, 1247, 1273-1274 — re-grep before editing, since earlier tasks in this same file shift line numbers)
- Test: `packages/solid-pod/src/pod.test.ts`

**Interfaces:**
- Consumes: existing `authorize(store, origin, path, request: AccessRequest): AccessDecision` is *not* called directly — reuse the DO's own existing `#decide(store, origin, path, mode, agent, requestOrigin): {granted:false,status}|null` (`pod.ts:346-368`), which already encodes the owner-bypass + `.acl`-path special-casing every other code path uses.
- Produces: new private method `#allowedToRead(store, origin, path, agent): boolean`; `#broadcast` signature changes from `(objectIri, type)` to `(store, origin, path, objectIri, type)`; `#handleWebSocketUpgrade` signature changes from `()` to `(agent: string | undefined)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/solid-pod/src/pod.test.ts`, using the file's existing `freshStub()` / `buildReq()` / `runInDurableObject` harness:

```ts
it("does not broadcast a change to a private resource to an unauthorized WebSocket subscriber", async () => {
  const stub = freshStub();

  // Seed a container-level ACL that denies public read (owner-only), then an
  // owner-authored resource inside it.
  await runInDurableObject(stub, async (instance) => {
    await instance.fetch(
      buildReq("PUT", "/private/.acl", {
        webid: OWNER,
        config: { owners: [OWNER] },
        headers: { "content-type": TURTLE },
        body: `
          @prefix acl: <http://www.w3.org/ns/auth/acl#>.
          <#owner> a acl:Authorization;
            acl:agent <${OWNER}>;
            acl:accessTo <./>;
            acl:default <./>;
            acl:mode acl:Read, acl:Write, acl:Control.
        `,
      }),
    );
  });

  // Open an anonymous WebSocket subscription against the same DO instance.
  const upgradeRes = await runInDurableObject(stub, (instance) =>
    instance.fetch(
      buildReq("GET", "/", {
        config: { owners: [OWNER] },
        headers: { upgrade: "websocket" },
      }),
    ),
  );
  expect(upgradeRes.status).toBe(101);
  const client = upgradeRes.webSocket;
  expect(client).toBeDefined();
  client!.accept();
  const received: string[] = [];
  client!.addEventListener("message", (event) => {
    received.push(String((event as MessageEvent).data));
  });

  // The owner writes a private resource — this triggers #broadcast.
  await runInDurableObject(stub, (instance) =>
    instance.fetch(
      buildReq("PUT", "/private/secret", {
        webid: OWNER,
        config: { owners: [OWNER] },
        headers: { "content-type": OCTET },
        body: "top secret",
      }),
    ),
  );

  // Give the DO's synchronous send a turn to reach the test's client socket.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/solid-pod pod -t "does not broadcast"`
Expected: FAIL — `received` has length 1 (today's `#broadcast` fans out to every socket with no filtering).

- [ ] **Step 3: Move config/agent extraction above the WebSocket branch**

```ts
// pod.ts — fetch(), replacing lines 210-240
  override async fetch(request: Request): Promise<Response> {
    const config: ForwardedConfig = (() => {
      const raw = request.headers.get(INTERNAL_HEADERS.config);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as ForwardedConfig;
      } catch {
        return {};
      }
    })();

    this.#owners = config.owners ?? [];
    this.#allowAnonymousWrites = config.allowAnonymousWrites ?? false;
    this.#storageRoot = config.storageRoot ?? "/";
    const store = this.#getStore(config);
    const url = new URL(request.url);
    const origin = url.origin;
    // Keep the path percent-encoded: decoding `%2F` would conflate it with a
    // real path separator and corrupt store keys / resource IRIs.
    const path = url.pathname;
    const webidHeader = request.headers.get(INTERNAL_HEADERS.webid);
    const agent =
      webidHeader && webidHeader.length > 0 ? webidHeader : undefined;

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#handleWebSocketUpgrade(agent);
    }

    const jti = request.headers.get(INTERNAL_HEADERS.jti) ?? undefined;
    const requestOrigin = request.headers.get("origin") ?? undefined;

    const method = request.method.toUpperCase();
```

(Everything from `const jti = ...` onward is unchanged — only reordered so `config`/`store`/`origin`/`path`/`agent` are computed before the WebSocket check instead of after it.)

- [ ] **Step 4: Thread the WebID onto the socket and WAC-filter the broadcast**

```ts
// pod.ts — replacing #handleWebSocketUpgrade and #broadcast (~line 1584 area)
  /**
   * Accept a hibernatable WebSocket subscription. v1 channels carry only the
   * changed resource IRI (no body). The connecting agent's WebID is attached
   * to the socket so `#broadcast` can WAC-filter per subscriber.
   */
  #handleWebSocketUpgrade(agent: string | undefined): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ agent });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether `agent` may read `path`, reusing the same owner-bypass + WAC
   * evaluation every other request path uses (`#decide` returns `null` for
   * "granted"). */
  #allowedToRead(
    store: Store,
    origin: string,
    path: string,
    agent: string | undefined,
  ): boolean {
    return (
      this.#decide(store, origin, path, "read", agent, undefined) === null
    );
  }

  /** Fan a change notification out to every connected subscriber authorized
   * to read the changed resource — an anonymous or unauthorized socket must
   * not learn that a private resource changed at all. */
  #broadcast(
    store: Store,
    origin: string,
    path: string,
    objectIri: string,
    type: ChangeType,
  ): void {
    const notification = JSON.stringify({
      "@context": ACTIVITYSTREAMS,
      type,
      object: objectIri,
      published: new Date().toISOString(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as
        | { agent?: string }
        | null;
      if (!this.#allowedToRead(store, origin, path, attachment?.agent)) {
        continue;
      }
      try {
        ws.send(notification);
      } catch {
        // gone mid-broadcast
      }
    }
  }
```

- [ ] **Step 5: Update every `#broadcast` call site to pass `store, origin, path`**

Re-grep first — earlier steps in this task do not shift these line numbers, but confirm before editing: `grep -n "#broadcast(" packages/solid-pod/src/pod.ts`. Each call site already has `store`, `origin`, and `path` in scope as local variables (they are what's passed into the adjacent `toIri(origin, path)` call). Change each, e.g.:

```ts
// before
this.#broadcast(toIri(origin, path), existed ? "Update" : "Create");
// after
this.#broadcast(store, origin, path, toIri(origin, path), existed ? "Update" : "Create");
```

Apply the equivalent transform at all 11 call sites (the two-line "move + delete" pair at ~684-685 uses `childIri`/`path` — pass `store, origin, path` there too, since `path` is the relevant resource for the child-creation event; the copy/move pair at ~1247/~1273-1274 uses `dest`/`from` as the second positional path argument to `toIri`, matching those local variables instead of `path`).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test --project @dwk/solid-pod pod`
Expected: PASS (full `pod.test.ts` — this is a widely-called private method, so run the whole file, not just the new test). Add a second assertion case (owner's own second socket *does* receive the notification) to guard against over-filtering; extend the same test or add a sibling one before considering this task done.

- [ ] **Step 7: Changeset + commit**

```markdown
---
"@dwk/solid-pod": patch
---

WAC-filter WebSocket change notifications per subscriber instead of
broadcasting every resource change (including private resources) to every
connected socket unfiltered. An anonymous or unauthorized client can no
longer passively enumerate pod contents by watching the notification stream.
```

```bash
git add packages/solid-pod/src/pod.ts packages/solid-pod/src/pod.test.ts .changeset/solid-pod-wac-broadcast.md
git commit -m "fix(solid-pod): WAC-filter WebSocket broadcast per subscriber"
```

---

### Task 5: mastodon-api — wrap route dispatch in try/catch (HIGH)

**Files:**
- Modify: `packages/mastodon-api/src/handler.ts:104-135` (`createMastodonApi`'s returned closure)
- Test: `packages/mastodon-api/src/handler.test.ts`

**Interfaces:**
- Consumes: existing `mastodonError(status: number, message: string): Response` (`errors.ts:6-10`), existing `recordNotFound()`, `withCors(...)`.
- Produces: none new — internal wrapping only.

- [ ] **Step 1: Write the failing test**

Add to `packages/mastodon-api/src/handler.test.ts`, using the file's existing `api()`/`testConfig`/`testCtx` harness. Force a route handler to throw by having a stubbed D1 call reject (match whatever stubbing pattern the file already uses for D1 elsewhere — e.g. a `D1Database` mock whose `prepare().bind().first()` rejects):

```ts
it("returns a Mastodon-shaped 500 instead of throwing when a route handler throws", async () => {
  const handler = api({
    /* ...existing testConfig, plus whatever seam this file already uses to
       inject a failing D1 call for one specific route... */
  });
  const res = await handler(
    new Request("https://mastodon.test/api/v1/accounts/verify_credentials", {
      headers: { authorization: "Bearer valid-test-token" },
    }),
    env,
    testCtx,
  );
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ error: "Internal server error" });
});
```

(Read `handler.test.ts` first to find the lightest-weight existing route + D1-failure seam already used elsewhere in the file, rather than inventing a new one — the file's existing `AUTH_DB` missing-binding test at lines 8-17 is a *different* case (a fail-fast startup guard, not a route throw) and its `.rejects.toThrow(...)` expectation must stay as-is per Step 4 below.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api handler -t "Mastodon-shaped 500"`
Expected: FAIL — the promise rejects instead of resolving to a `500` `Response`.

- [ ] **Step 3: Wrap dispatch, keeping the `AUTH_DB` guard outside the try**

```ts
// handler.ts
import { mastodonError, recordNotFound } from "./errors.js";
// ...
  return async (request, env, _ctx) => {
    if (!env.AUTH_DB) {
      throw new Error(
        "@dwk/mastodon-api: missing required D1 binding `AUTH_DB`",
      );
    }
    try {
      if (request.method.toUpperCase() === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const url = new URL(request.url);
      const route = ROUTES.get(
        `${request.method.toUpperCase()} ${url.pathname}`,
      );
      if (route) {
        return withCors(await route({ config, env, request, url }));
      }
      for (const [method, pattern, dynamicHandler] of DYNAMIC_ROUTES) {
        if (request.method.toUpperCase() !== method) continue;
        const match = pattern.exec(url.pathname);
        if (match?.[1]) {
          let id: string;
          try {
            id = decodeURIComponent(match[1]);
          } catch {
            return withCors(recordNotFound());
          }
          return withCors(
            await dynamicHandler({ config, env, request, url }, id),
          );
        }
      }
      return withCors(recordNotFound());
    } catch (err) {
      console.error("@dwk/mastodon-api: unhandled route error", err);
      return withCors(mastodonError(500, "Internal server error"));
    }
  };
```

(Match the exact existing dispatcher body — read `handler.ts:104-135` immediately before editing to confirm variable names `ROUTES`/`DYNAMIC_ROUTES`/`CORS_HEADERS`/`config` match current `HEAD`; the shape above is what the research pass observed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api handler`
Expected: PASS (full file — confirms the pre-existing `AUTH_DB` missing-binding test still throws, since that guard stays outside the new `try`, and every other routing test still dispatches correctly through the wrapped body).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/mastodon-api": patch
---

Wrap route dispatch in try/catch so a D1 failure or internal invariant throw
returns the documented Mastodon JSON error shape (`{"error": "..."}`,
via `mastodonError`) instead of an unhandled exception.
```

```bash
git add packages/mastodon-api/src/handler.ts packages/mastodon-api/src/handler.test.ts .changeset/mastodon-api-error-contract.md
git commit -m "fix(mastodon-api): return Mastodon-shaped errors instead of throwing"
```

---

### Task 6: mastodon-api — constant-time client-secret comparison (MEDIUM)

**Files:**
- Modify: `packages/mastodon-api/src/encoding.ts:46-53` (`timingSafeEqualHex`)
- Test: `packages/mastodon-api/src/encoding.test.ts:30-34`

**Interfaces:**
- Consumes: none new.
- Produces: `timingSafeEqualHex(a: string, b: string): boolean` — signature unchanged (still synchronous), so the sole call site `auth.ts:43` needs no edit.

- [ ] **Step 1: Write the failing test**

The existing `encoding.test.ts:30-34` already covers equal/unequal cases behaviorally; add one asserting the underlying primitive is actually used (guards against a future regression to the hand-rolled loop), e.g.:

```ts
it("uses crypto.subtle.timingSafeEqual under the hood", () => {
  const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
  timingSafeEqualHex("ab".repeat(32), "ab".repeat(32));
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/mastodon-api encoding -t "under the hood"`
Expected: FAIL — the current hand-rolled `charCodeAt` XOR loop never calls `crypto.subtle.timingSafeEqual`.

- [ ] **Step 3: Implement using the Cloudflare-documented pattern**

```ts
// encoding.ts
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time comparison of two hex digests via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Do not short-circuit on length — that
 * itself leaks length via timing; compare the value against itself instead
 * when lengths differ, per Cloudflare's documented safe pattern.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bytesA = hexToBytes(a);
  const bytesB = hexToBytes(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/mastodon-api encoding`
Expected: PASS (full file).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/mastodon-api": patch
---

Use `crypto.subtle.timingSafeEqual` for client-secret/token hex comparison
instead of a hand-rolled constant-time loop.
```

```bash
git add packages/mastodon-api/src/encoding.ts packages/mastodon-api/src/encoding.test.ts .changeset/mastodon-api-timing-safe-hex.md
git commit -m "fix(mastodon-api): use crypto.subtle.timingSafeEqual for hex comparison"
```

---

### Task 7: micropub — background fediverse syndication via ctx.waitUntil (HIGH)

**Files:**
- Modify: `packages/micropub/src/handler.ts:1441-1449` (`publishPost`), `:1608-1611` (factory), `handleAction`/`doCreate` call chain between them
- Test: `packages/micropub/src/index.test.ts` or `composition.test.ts` (whichever already builds a `config.fediverse` fixture — check both; add one if neither does)

**Interfaces:**
- Consumes: existing `syndicateEntry(...)` (`fediverse.ts:230-267`, unchanged), existing `MicropubHandler` type (`handler.ts:79-83`, `(request, env, ctx) => Promise<Response>` — `ctx: ExecutionContext`).
- Produces: `publishPost` gains an optional trailing parameter `waitUntil?: (promise: Promise<unknown>) => void`; `doCreate`/`handleAction` thread the same optional parameter through unchanged otherwise. `mcp-tools.ts:140`'s direct call to `publishPost(mf2, commands, config, store)` needs **no** change (omitting the new optional param preserves today's awaited behavior for the MCP path).

- [ ] **Step 1: Write the failing test**

```ts
it("does not block the create response on fediverse syndication", async () => {
  let resolveSyndication!: () => void;
  const syndicationBlocked = new Promise<void>((resolve) => {
    resolveSyndication = resolve;
  });
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
  } as unknown as ExecutionContext;

  const handler = createMicropub({
    /* ...existing base config fixture... */
    fediverse: {
      /* ...minimal fediverse config that ultimately calls a fetch stub
         which stays pending until resolveSyndication() runs... */
    },
  });

  const start = Date.now();
  const res = await handler(createRequestWithSyndicateTo(), env, ctx);
  const elapsed = Date.now() - start;

  expect(res.status).toBe(201);
  expect(elapsed).toBeLessThan(50); // did not wait on the pending syndication
  expect(waited).toHaveLength(1); // syndication was handed to ctx.waitUntil
  resolveSyndication();
  await waited[0];
});
```

(Build the pending-fetch fixture using whatever fetch-stubbing convention this package's existing fediverse tests already use — check `fediverse.test.ts` for the established pattern before inventing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/micropub index -t "does not block"`
Expected: FAIL — today's inline `await syndicateEntry(...)` makes `elapsed` include the full pending duration, and `waited` stays empty since `ctx` is discarded as `_ctx`.

- [ ] **Step 3: Thread `waitUntil` through `publishPost` → `doCreate`/`handleAction` → the factory**

```ts
// handler.ts — publishPost
export async function publishPost(
  mf2: Mf2Object,
  commands: MicropubCommands,
  config: ResolvedConfig,
  store: MicropubStore,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<PublishPostResult> {
  // ...unchanged body up to the syndication call...
  if (config.fediverse && commands.syndicateTo.length > 0) {
    // Never fatal — the post is already created; syndication runs in the
    // background so a slow/unreachable fediverse peer cannot delay the
    // client's create response.
    const syndication = syndicateEntry(
      config.fediverse,
      mf2,
      commands.syndicateTo,
      await config.syndicateTo(),
      config.logger,
    );
    if (waitUntil) {
      waitUntil(syndication);
    } else {
      await syndication;
    }
  }
  return { ok: true, url };
}
```

```ts
// handler.ts — doCreate and handleAction: add the same optional trailing
// parameter and pass it straight through to publishPost, e.g.
async function doCreate(
  mf2: Mf2Object,
  commands: MicropubCommands,
  config: ResolvedConfig,
  store: MicropubStore,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const result = await publishPost(mf2, commands, config, store, waitUntil);
  // ...unchanged...
}
```

```ts
// handler.ts — createMicropub factory: un-discard ctx
  return async (request, env, ctx) => {
    // ...unchanged up to the POST branch...
    if (method === "POST") {
      return handleAction(request, env, resolved, store, ctx.waitUntil.bind(ctx));
    }
    // ...
```

(Read the actual current call chain between `handleAction` and `doCreate` before editing — thread the parameter through every intermediate function in that chain, not just the two named here; the research pass confirmed `doCreate`/`handleAction`/`publishPost` as the three functions in the path but did not enumerate every intermediate helper.)

`mcp-tools.ts:140`'s `publishPost(mf2, commands, config, store)` call is unaffected — the fifth parameter is optional and omitting it preserves the current always-`await` behavior, which is required there since `ToolDefinition.handler` never receives an `ExecutionContext`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/micropub`
Expected: PASS (full package — `publishPost`'s signature change ripples through several call sites; run the whole suite, including `mcp-tools.test.ts` if it exists, to confirm the MCP path's behavior is unchanged).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/micropub": patch
---

Background fediverse syndication via `ctx.waitUntil` instead of awaiting it
inline in the create-post response path, so a slow or unreachable fediverse
peer no longer delays the client's response. The MCP tool path (which has no
`ExecutionContext`) is unaffected and still awaits syndication inline.
```

```bash
git add packages/micropub/src/handler.ts packages/micropub/src/index.test.ts .changeset/micropub-background-syndication.md
git commit -m "fix(micropub): background fediverse syndication via ctx.waitUntil"
```

---

### Task 8: micropub — stop leaking raw D1 error messages to clients (MEDIUM)

**Files:**
- Modify: `packages/micropub/src/handler.ts:429-461` (`storeMedia`'s fail-closed catch branch)
- Test: `packages/micropub/src/media.test.ts`

**Interfaces:**
- Consumes: existing `config.logger` (already injected per `config.ts:239`), existing `MicropubLogEvent.MediaMetadataFailed` (`log.ts:44-50`), existing `MediaMetadataError` class.
- Produces: none new — `MediaMetadataError`'s message text changes from embedding the raw D1 error to a fixed, generic string; both catch sites that relay it (`handleMediaUpload:535-537`, `handleAction`'s multipart-create fold `:1312-1314`) inherit the fix with no code change of their own, since they just relay `err.message`.

- [ ] **Step 1: Write the failing test**

```ts
it("logs the D1 failure and does not leak its message to the client", async () => {
  const logged: Array<[string, unknown]> = [];
  const config = resolveConfig({
    /* ...existing base fixture... */
    logger: {
      debug: () => {},
      info: () => {},
      warn: (event, fields) => logged.push([event, fields]),
      error: (event, fields) => logged.push([event, fields]),
    },
  });
  // Stub env.MEDIA_DB (or whichever binding storeMedia's insert uses) to
  // reject with a message that must never reach the client, e.g. one
  // containing a table/column name.
  const env = { ...baseEnv, MEDIA_DB: rejectingD1("no such column: internal_col") };

  const res = await handleMediaUpload(/* ...request, config, env... */);
  const body = await res.json();

  expect(body.error_description).not.toContain("internal_col");
  expect(logged.some(([event]) => event === MicropubLogEvent.MediaMetadataFailed)).toBe(true);
});
```

(Match the exact binding name and request-construction helpers this test file already uses for `storeMedia`/`handleMediaUpload` — read `media.test.ts` first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/micropub media -t "does not leak"`
Expected: FAIL — `body.error_description` currently contains the raw D1 message, and today's `emit(config, "warn", ...)` call sits in the *other* (non-fail-closed) branch, not this one.

- [ ] **Step 3: Log before throwing, and stop embedding the raw message**

```ts
// handler.ts — storeMedia's catch branch
  } catch (err) {
    if (config.extensions.proposed) {
      config.logger.error(MicropubLogEvent.MediaMetadataFailed, {
        reason: err instanceof Error ? err.message : String(err),
      });
      try {
        await env.MEDIA.delete(key);
      } catch {
        // best-effort
      }
      throw new MediaMetadataError(
        "failed to record media metadata; the upload was rolled back",
      );
    }
    emit(config, "warn", MicropubLogEvent.MediaMetadataFailed, {});
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/micropub media`
Expected: PASS (full file).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/micropub": patch
---

Log the underlying D1 failure via the injected logger and return a generic
`error_description` when media metadata insert fails, instead of relaying
the raw database error message verbatim to the client.
```

```bash
git add packages/micropub/src/handler.ts packages/micropub/src/media.test.ts .changeset/micropub-media-error-logging.md
git commit -m "fix(micropub): stop leaking raw D1 errors, log them instead"
```

---

### Task 9: solid-oidc — cap the token endpoint's form-body read (MEDIUM)

**Files:**
- Create: `packages/solid-oidc/src/body.ts` (ported, `Request`-flavored capped reader — mirrors `@dwk/activitypub`'s `packages/activitypub/src/body.ts:33-84`, the established precedent for this exact scenario)
- Modify: `packages/solid-oidc/src/token-endpoint.ts:19-30` (`readForm`)
- Test: `packages/solid-oidc/src/body.test.ts` (new), `packages/solid-oidc/src/handler.test.ts`

**Interfaces:**
- Consumes: none new (no new dependency — ports the existing pattern locally rather than depending on `@dwk/activitypub`, which would be a layering violation; `@dwk/safe-fetch`'s existing `readBodyCapped` takes a `Response`, not a `Request`, so it doesn't fit here without its own change, which is out of scope).
- Produces: `readRequestBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null>` (returns `null` when the body exceeds `maxBytes`, mirroring the activitypub original).

- [ ] **Step 1: Write the failing test (for the new capped reader)**

Create `packages/solid-oidc/src/body.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readRequestBodyCapped } from "./body.js";

describe("readRequestBodyCapped", () => {
  it("reads a body under the cap", async () => {
    const request = new Request("https://example.test/token", {
      method: "POST",
      body: "grant_type=authorization_code",
    });
    const bytes = await readRequestBodyCapped(request, 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe(
      "grant_type=authorization_code",
    );
  });

  it("returns null when the body exceeds the cap", async () => {
    const request = new Request("https://example.test/token", {
      method: "POST",
      body: "x".repeat(2000),
    });
    const bytes = await readRequestBodyCapped(request, 1024);
    expect(bytes).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/solid-oidc body`
Expected: FAIL — `body.ts` doesn't exist yet.

- [ ] **Step 3: Port the capped reader**

Read `packages/activitypub/src/body.ts:33-84` first and port its `readRequestBodyCapped` function verbatim into `packages/solid-oidc/src/body.ts`, adjusting only the doc comment to this package's context (a public, unauthenticated token endpoint rather than a federation inbox):

```ts
/**
 * Read a `Request` body up to a byte cap, refusing to buffer more. The
 * token endpoint is public and unauthenticated prior to code/PKCE/DPoP
 * validation, so an oversized body must not be buffered in full before
 * that validation runs. Mirrors `@dwk/activitypub`'s
 * `readRequestBodyCapped` (same problem: a `Request`-flavored capped read,
 * which `@dwk/safe-fetch`'s `readBodyCapped` doesn't cover since that one
 * takes a `Response`).
 */
export async function readRequestBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  // ... (verbatim port of packages/activitypub/src/body.ts's implementation)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/solid-oidc body`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `readForm` using the cap**

Add to `packages/solid-oidc/src/handler.test.ts` (or a new `token-endpoint.test.ts` if the package doesn't have one yet — check first):

```ts
it("rejects an oversized token request body as invalid_request", async () => {
  const handler = createSolidOidc(/* ...existing base config... */);
  const res = await handler(
    new Request("https://oidc.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&padding=${"x".repeat(16 * 1024)}`,
    }),
    env,
    testCtx,
  );
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("invalid_request");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test --project @dwk/solid-oidc handler -t "oversized"`
Expected: FAIL — today's `request.formData()` buffers it fully and parses successfully (the oversized field is just another form value), returning `unsupported_grant_type` or similar rather than `invalid_request`.

- [ ] **Step 7: Implement the capped `readForm`**

```ts
// token-endpoint.ts
import { readRequestBodyCapped } from "./body.js";

const MAX_TOKEN_BODY_BYTES = 8 * 1024; // form fields here are short opaque tokens

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const bytes = await readRequestBodyCapped(request, MAX_TOKEN_BODY_BYTES);
  if (bytes === null) return null;
  try {
    return new URLSearchParams(new TextDecoder().decode(bytes));
  } catch {
    return new URLSearchParams();
  }
}
```

```ts
// token-endpoint.ts — handleToken, right after reading the form
  const form = await readForm(request);
  if (form === null) {
    return oauthError(400, "invalid_request", "request body exceeds the maximum allowed size");
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test --project @dwk/solid-oidc`
Expected: PASS (full package — confirms every existing token-endpoint test, which posts well-under-cap bodies, still behaves identically).

- [ ] **Step 9: Changeset + commit**

```markdown
---
"@dwk/solid-oidc": patch
---

Cap the token endpoint's form-body read at 8 KiB before PKCE/code/DPoP
validation runs, instead of buffering an unbounded body on this public,
unauthenticated endpoint.
```

```bash
git add packages/solid-oidc/src/body.ts packages/solid-oidc/src/body.test.ts packages/solid-oidc/src/token-endpoint.ts packages/solid-oidc/src/handler.test.ts .changeset/solid-oidc-token-body-cap.md
git commit -m "fix(solid-oidc): cap token endpoint body size before validation"
```

---

### Task 10: solid-oidc — construct `CodeStore` once per Worker isolate (MEDIUM)

**Files:**
- Modify: `packages/solid-oidc/src/handler.ts:35-45` (`createSolidOidc`)
- Test: `packages/solid-oidc/src/handler.test.ts`

**Interfaces:**
- Consumes: existing `createCodeStore(db: D1Database): CodeStore` (`store.ts:48-67`, unchanged).
- Produces: none new.

- [ ] **Step 1: Write the failing test**

```ts
it("does not rebuild CodeStore's D1 schema check on every request", async () => {
  let ensureSchemaCalls = 0;
  const db = wrapD1WithSchemaCallCounter(env.AUTH_DB, () => {
    ensureSchemaCalls += 1;
  });
  const handler = createSolidOidc(/* ...existing base config... */);

  await handler(discoveryRequest(), { ...env, AUTH_DB: db }, testCtx);
  await handler(discoveryRequest(), { ...env, AUTH_DB: db }, testCtx);
  await handler(discoveryRequest(), { ...env, AUTH_DB: db }, testCtx);

  // Discovery never touches `codes` at all — this also proves the fix stops
  // constructing CodeStore (and its schema-check D1 round trip) for routes
  // that never redeem/save a code.
  expect(ensureSchemaCalls).toBe(0);
});
```

(`wrapD1WithSchemaCallCounter` needs to be a small local helper counting `CREATE TABLE IF NOT EXISTS` executions against the D1 stub — check whether `store.test.ts` already has an equivalent D1-call-counting fixture to reuse instead of writing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/solid-oidc handler -t "does not rebuild"`
Expected: PASS already for *discovery specifically* under today's code, actually — re-derive this test to hit `/token` or `/authorize` three times instead, which do construct `CodeStore` every request today:

```ts
it("does not rebuild CodeStore's D1 schema check on every /authorize request", async () => {
  let ensureSchemaCalls = 0;
  const db = wrapD1WithSchemaCallCounter(env.AUTH_DB, () => {
    ensureSchemaCalls += 1;
  });
  const handler = createSolidOidc(/* ... */);
  const request = () => authorizeRequest(/* valid params */);

  await handler(request(), { ...env, AUTH_DB: db }, testCtx);
  await handler(request(), { ...env, AUTH_DB: db }, testCtx);

  expect(ensureSchemaCalls).toBe(1);
});
```

Expected: FAIL — today's code constructs a fresh `CodeStore` (and re-runs its schema-check) on both calls, so `ensureSchemaCalls` is `2`.

- [ ] **Step 3: Memoize `CodeStore` once per handler instance**

```ts
// handler.ts
export function createSolidOidc(config: SolidOidcConfig): SolidOidcHandler {
  const resolved: ResolvedSolidOidcConfig = resolveConfig(config);
  let codes: CodeStore | null = null;

  return async (request, env) => {
    if (!env.AUTH_DB) {
      throw new Error("@dwk/solid-oidc: required binding AUTH_DB is missing");
    }
    // The D1 binding is fixed for the life of this Worker isolate (it is not
    // a per-request value), so the store — and its one-time schema-check —
    // only needs to be built once, not on every /authorize or /token call.
    codes ??= createCodeStore(env.AUTH_DB);
    const url = new URL(request.url);
    // ...unchanged rest of the function...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/solid-oidc`
Expected: PASS (full package).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/solid-oidc": patch
---

Construct `CodeStore` once per Worker isolate instead of once per request,
avoiding a redundant D1 schema-check round trip on every `/authorize` and
`/token` call (and skipping it entirely for discovery/JWKS requests, which
never touch it).
```

```bash
git add packages/solid-oidc/src/handler.ts packages/solid-oidc/src/handler.test.ts .changeset/solid-oidc-memoize-codestore.md
git commit -m "fix(solid-oidc): construct CodeStore once per isolate"
```

---

### Task 11: solid-oidc — wire logger/metrics at security-relevant rejection points (MEDIUM)

**Files:**
- Modify: `packages/solid-oidc/src/config.ts:95-98,114-115,159-160` (`logger`/`metrics` defaults)
- Modify: `packages/solid-oidc/src/log.ts` (create — new `SolidOidcLogEvent` enum, mirroring `packages/micropub/src/log.ts` / `packages/activitypub/src/log.ts`'s shape)
- Modify: `packages/solid-oidc/src/token-endpoint.ts:57-98` (five rejection points)
- Test: `packages/solid-oidc/src/handler.test.ts`

**Interfaces:**
- Consumes: existing `noopLogger`, `noopMetrics` from `@dwk/log`.
- Produces: `ResolvedSolidOidcConfig.logger`/`.metrics` become non-optional (`Logger`/`Metrics` instead of `Logger?`/`Metrics?`); new `SolidOidcLogEvent` enum exported from a new `log.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it("logs a warn event when a DPoP proof is rejected at the token endpoint", async () => {
  const logged: Array<[string, string, unknown]> = [];
  const handler = createSolidOidc({
    /* ...existing base config... */
    logger: {
      debug: () => {},
      info: () => {},
      warn: (event, fields) => logged.push(["warn", event, fields]),
      error: (event, fields) => logged.push(["error", event, fields]),
    },
    metrics: { count: () => {}, observe: () => {} },
  });

  const res = await handler(
    new Request("https://oidc.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, // no DPoP header
      body: "grant_type=authorization_code&code=x&redirect_uri=https://client.test&client_id=https://client.test&code_verifier=y",
    }),
    env,
    testCtx,
  );

  expect(res.status).toBe(400);
  expect(logged).toContainEqual([
    "warn",
    SolidOidcLogEvent.DpopRejected,
    expect.objectContaining({ reason: expect.any(String) }),
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/solid-oidc handler -t "DPoP proof is rejected"`
Expected: FAIL — `SolidOidcLogEvent` doesn't exist, and nothing in `token-endpoint.ts` calls `config.logger`/`config.metrics` today.

- [ ] **Step 3: Default logger/metrics to noop (`config.ts`)**

```ts
// config.ts — SolidOidcConfig stays optional (composer-facing); ResolvedSolidOidcConfig becomes non-optional
export interface ResolvedSolidOidcConfig {
  // ...unchanged fields...
  readonly logger: Logger;
  readonly metrics: Metrics;
  // ...
}
```

```ts
// config.ts — resolveConfig, replacing the two conditional-spread lines
import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
// ...
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
```

- [ ] **Step 4: Add the event vocabulary**

Create `packages/solid-oidc/src/log.ts`:

```ts
/**
 * The structured-logging vocabulary for `@dwk/solid-oidc`.
 *
 * Only security-relevant rejections are logged (a request that never reaches
 * a state worth alerting on stays silent) — a rejected DPoP proof, an
 * invalid/replayed/expired code, or a failed PKCE verification.
 */

/** Stable, dotted event names emitted on the logger and metrics seams. */
export enum SolidOidcLogEvent {
  /** The token endpoint rejected a request's DPoP proof (missing or invalid). */
  DpopRejected = "solid_oidc.token.dpop_rejected",
  /** The token endpoint rejected an unknown, already-used, or expired code,
   * or a code/redirect_uri/client_id mismatch. */
  InvalidGrant = "solid_oidc.token.invalid_grant",
  /** The token endpoint rejected a PKCE verifier that didn't match the
   * stored challenge. */
  PkceMismatch = "solid_oidc.token.pkce_mismatch",
}
```

- [ ] **Step 5: Emit at the five rejection points in `token-endpoint.ts`**

```ts
// token-endpoint.ts
import { SolidOidcLogEvent } from "./log.js";

function emit(
  config: ResolvedSolidOidcConfig,
  event: SolidOidcLogEvent,
  fields?: Record<string, unknown>,
): void {
  config.logger.warn(event, fields);
  config.metrics.count(event, fields);
}

export async function handleToken(
  request: Request,
  config: ResolvedSolidOidcConfig,
  codes: CodeStore,
): Promise<Response> {
  // ...unchanged up to the DPoP header check...
  const proof = request.headers.get("DPoP");
  if (!proof) {
    emit(config, SolidOidcLogEvent.DpopRejected, { reason: "missing" });
    return oauthError(
      400,
      "invalid_dpop_proof",
      "a DPoP proof is required at the token endpoint",
    );
  }
  const dpop = await verifyDpopProof({ /* ...unchanged... */ });
  if (!dpop.valid || !dpop.jkt) {
    emit(config, SolidOidcLogEvent.DpopRejected, {
      reason: dpop.reason ?? "invalid",
    });
    return oauthError(
      400,
      "invalid_dpop_proof",
      `DPoP proof rejected (${dpop.reason ?? "invalid"})`,
    );
  }

  const record = await codes.redeem(code, Math.floor(config.now() / 1000));
  if (!record) {
    emit(config, SolidOidcLogEvent.InvalidGrant, {
      reason: "code_invalid_used_or_expired",
    });
    return oauthError(
      400,
      "invalid_grant",
      "code is invalid, used, or expired",
    );
  }
  if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
    emit(config, SolidOidcLogEvent.InvalidGrant, {
      reason: "client_or_redirect_mismatch",
    });
    return oauthError(
      400,
      "invalid_grant",
      "client_id / redirect_uri does not match the code",
    );
  }
  if (!(await verifyPkce(codeVerifier, record.codeChallenge))) {
    emit(config, SolidOidcLogEvent.PkceMismatch);
    return oauthError(400, "invalid_grant", "PKCE verification failed");
  }
  // ...unchanged success path...
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test --project @dwk/solid-oidc`
Expected: PASS (full package — the `ResolvedSolidOidcConfig.logger`/`.metrics` type change from optional to required could break any test constructing that type by hand; fix any such fixture to rely on `resolveConfig`'s defaulting instead of hand-building a resolved config).

- [ ] **Step 7: Changeset + commit**

```markdown
---
"@dwk/solid-oidc": patch
---

Call the injected `logger`/`metrics` seam at the token endpoint's
security-relevant rejection points (DPoP proof rejected, invalid/replayed
code, PKCE mismatch) — previously wired but never invoked anywhere in the
package.
```

```bash
git add packages/solid-oidc/src/config.ts packages/solid-oidc/src/log.ts packages/solid-oidc/src/token-endpoint.ts packages/solid-oidc/src/handler.test.ts .changeset/solid-oidc-log-rejections.md
git commit -m "fix(solid-oidc): log security-relevant token rejections"
```

---

### Task 12: indieauth — constant-time PKCE/HMAC comparison (MEDIUM)

**Files:**
- Modify: `packages/indieauth/src/encoding.ts:53-58` (`timingSafeEqual`)
- Test: `packages/indieauth/src/encoding.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `timingSafeEqual(a: string, b: string): boolean` — signature unchanged (stays synchronous), so `pkce.ts:9,45` and `token.ts:23,236` need **no** edits.

- [ ] **Step 1: Write the failing test**

```ts
it("uses crypto.subtle.timingSafeEqual under the hood", () => {
  const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
  timingSafeEqual("same-length-a", "same-length-b");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

it("rejects different-length inputs without an early return", () => {
  const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
  expect(timingSafeEqual("short", "much-longer-value")).toBe(false);
  // A safe implementation still calls the primitive (against itself) rather
  // than short-circuiting before ever touching it.
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/indieauth encoding -t "under the hood"`
Expected: FAIL — the current hand-rolled loop never calls `crypto.subtle.timingSafeEqual`, and the length-mismatch case returns `false` via an early `if (a.length !== b.length) return false` with no call to the primitive at all.

- [ ] **Step 3: Implement using the Cloudflare-documented pattern**

```ts
// encoding.ts
/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Used for PKCE challenge and HMAC
 * signature checks — do not short-circuit on length mismatch, which itself
 * leaks length via timing; compare the value against itself instead, per
 * Cloudflare's documented safe pattern.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/indieauth`
Expected: PASS (full package — `timingSafeEqual` gates both PKCE verification in `pkce.ts` and HMAC signature checks in `token.ts`; run the whole suite to confirm neither regresses).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/indieauth": patch
---

Use `crypto.subtle.timingSafeEqual` for PKCE and HMAC signature comparison
instead of a hand-rolled loop that short-circuited (and leaked timing) on a
length mismatch.
```

```bash
git add packages/indieauth/src/encoding.ts packages/indieauth/src/encoding.test.ts .changeset/indieauth-timing-safe-equal.md
git commit -m "fix(indieauth): use crypto.subtle.timingSafeEqual for PKCE/HMAC comparison"
```

---

### Task 13: microsub — replace `Math.random()` in channel uid generation (MEDIUM)

**Files:**
- Modify: `packages/microsub/src/store.ts:255-261` (`generateUid`)
- Test: `packages/microsub/src/store.test.ts`

**Interfaces:**
- Consumes: none new (`crypto.randomUUID()` is a standard Workers-runtime global, already used elsewhere in the monorepo e.g. `packages/micropub/src/handler.ts:435,1130`).
- Produces: `generateUid(): string` — same signature, different format (a UUID instead of a base36 timestamp+suffix string). Confirm no test or consumer asserts the old format (`store.test.ts` was confirmed to only assert equality/membership, not format).

- [ ] **Step 1: Write the failing test**

```ts
it("generates a channel uid using crypto.randomUUID, not Math.random", () => {
  const spy = vi.spyOn(Math, "random");
  const uid = generateUid();
  expect(spy).not.toHaveBeenCalled();
  expect(uid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  spy.mockRestore();
});
```

(`generateUid` is currently unexported per the research pass — if `store.test.ts` can't import it directly, drive this assertion through `createChannel` instead, asserting the returned channel's `uid` field matches the UUID pattern and that `Math.random` was never called during channel creation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/microsub store -t "crypto.randomUUID"`
Expected: FAIL — today's implementation calls `Math.random()` and produces a base36 string, not a UUID.

- [ ] **Step 3: Implement**

```ts
// store.ts
function generateUid(): string {
  return crypto.randomUUID();
}
```

(Remove the now-inaccurate "short, base36 timestamp + suffix" doc comment above it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/microsub`
Expected: PASS (full package).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/microsub": patch
---

Generate channel uids with `crypto.randomUUID()` instead of `Math.random()`.
```

```bash
git add packages/microsub/src/store.ts packages/microsub/src/store.test.ts .changeset/microsub-random-uuid.md
git commit -m "fix(microsub): use crypto.randomUUID for channel uid generation"
```

---

### Task 14: activitypub — enforce `readBodyCapped` in `object.ts`'s two remaining fetch sites (MEDIUM)

**Files:**
- Modify: `packages/activitypub/src/object.ts:2860-2866` (`#processVerifications`)
- Modify: `packages/activitypub/src/object.ts:3293-3299` (`#resolveInbox`)
- Test: `packages/activitypub/src/object.test.ts`

**Interfaces:**
- Consumes: existing `readBodyCapped(response: Response, maxBytes?: number): Promise<string | null>` from `@dwk/safe-fetch` (already imported at `object.ts:29`), existing `ACTOR_PROFILE_MAX_BODY_BYTES = 128 * 1024` (`object.ts:76`) — reuse it rather than defining a new constant, since both sites parse the same kind of remote JSON document (an actor/verification document) at the same trust boundary.
- Produces: none new.

- [ ] **Step 1: Write the failing test**

Add to `object.test.ts`, mirroring the existing oversized-body test pattern from `packages/safe-fetch/src/body.test.ts:10-27` (a lying `content-length` header) combined with this file's existing fetch-stubbing helper (`withFetch`/`followWith`-style, per `object.test.ts:95-107`):

```ts
it("does not buffer an oversized verification document body", async () => {
  const oversized = "x".repeat(ACTOR_PROFILE_MAX_BODY_BYTES + 1024);
  withFetch(async () => new Response(oversized, {
    headers: { "content-length": String(oversized.length) },
  }));

  const result = await runInDurableObject(stub, (instance) =>
    instance.processVerificationsForTest(/* ...existing fixture args... */),
  );

  // The existing "gives up when the actor document is not valid JSON" case
  // (object.test.ts ~716-725) asserts a graceful no-op on parse failure;
  // an oversized body must fail the same graceful way, not hang or OOM.
  expect(result).toEqual(/* the same graceful "gave up" shape as that test */);
});
```

(Read `object.test.ts:95-107` and `:684-736` first to match the exact fetch-stubbing helper name and the exact "gave up" assertion shape already established for the parse-failure case — this new test should look like a sibling of that one, differing only in *why* the body was rejected.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/activitypub object -t "oversized verification"`
Expected: FAIL (or, if it happens to pass because the test environment doesn't actually enforce memory limits, at minimum confirm via a spy that `response.json()` was called directly with the full oversized body rather than going through `readBodyCapped`).

- [ ] **Step 3: Fix `#processVerifications` (`object.ts:2860-2866`)**

```ts
// before
if (response.ok) {
  let doc: unknown;
  try {
    doc = await response.json();
  } catch {
    doc = null;
  }
  // ...
}

// after
if (response.ok) {
  let doc: unknown = null;
  const body = await readBodyCapped(response, ACTOR_PROFILE_MAX_BODY_BYTES);
  if (body !== null) {
    try {
      doc = JSON.parse(body) as unknown;
    } catch {
      doc = null;
    }
  }
  // ...
}
```

- [ ] **Step 4: Fix `#resolveInbox` (`object.ts:3293-3299`)**

```ts
// before
if (!response.ok) return null;
let doc: unknown;
try {
  doc = await response.json();
} catch {
  return null;
}

// after
if (!response.ok) return null;
const body = await readBodyCapped(response, ACTOR_PROFILE_MAX_BODY_BYTES);
if (body === null) return null;
let doc: unknown;
try {
  doc = JSON.parse(body) as unknown;
} catch {
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --project @dwk/activitypub object`
Expected: PASS (full file — both sites are on hot verification/delivery paths, so run the whole suite).

- [ ] **Step 6: Changeset + commit**

```markdown
---
"@dwk/activitypub": patch
---

Enforce `readBodyCapped` at the two remaining unbounded remote-fetch sites in
`object.ts` (`#processVerifications`, `#resolveInbox`), matching the capped
read discipline the rest of the file already follows.
```

```bash
git add packages/activitypub/src/object.ts packages/activitypub/src/object.test.ts .changeset/activitypub-cap-verification-fetches.md
git commit -m "fix(activitypub): cap two remaining unbounded remote-fetch reads"
```

---

### Task 15: vc — real type guard for `findVerificationMethod` (MEDIUM)

**Files:**
- Modify: `packages/vc/src/did-web.ts:187-206` (`findVerificationMethod`)
- Test: `packages/vc/src/did-web.test.ts`

**Interfaces:**
- Consumes: existing `VerificationMethod` type (`packages/vc/src/data-integrity.ts:208-214`: `{ id: string; type?: string; controller?: string; publicKeyMultibase?: string; publicKeyJwk?: JsonWebKey }`).
- Produces: new (unexported, module-local) `isVerificationMethodShape` guard; `findVerificationMethod`'s exported signature is unchanged (`(didDocument: JsonObject, id: string) => VerificationMethod | undefined`).

- [ ] **Step 1: Write the failing test**

Add to `did-web.test.ts`, alongside the existing `describe("findVerificationMethod / createDidWebResolver")` block:

```ts
it("does not return an entry whose type fields are the wrong shape", () => {
  const didDocument = {
    id: "did:web:example.com",
    verificationMethod: [
      {
        id: "did:web:example.com#key-0",
        type: 12345, // wrong shape: should be a string
        controller: "did:web:example.com",
        publicKeyJwk: { kty: "EC" },
      },
    ],
  };
  expect(
    findVerificationMethod(didDocument, "did:web:example.com#key-0"),
  ).toBeUndefined();
});

it("does not return an entry whose publicKeyJwk is an array instead of an object", () => {
  const didDocument = {
    id: "did:web:example.com",
    verificationMethod: [
      {
        id: "did:web:example.com#key-0",
        type: "JsonWebKey2020",
        publicKeyJwk: ["not", "an", "object"],
      },
    ],
  };
  expect(
    findVerificationMethod(didDocument, "did:web:example.com#key-0"),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/vc did-web -t "wrong shape"`
Expected: FAIL — today's blind `entry as unknown as VerificationMethod` cast returns the malformed entry rather than `undefined`.

- [ ] **Step 3: Implement the guard**

```ts
// did-web.ts
/** Runtime guard: does `entry` have the shape of a `VerificationMethod`? */
function isVerificationMethodShape(
  entry: JsonObject,
): entry is JsonObject & VerificationMethod {
  if (typeof entry.id !== "string") return false;
  if (entry.type !== undefined && typeof entry.type !== "string") {
    return false;
  }
  if (
    entry.controller !== undefined &&
    typeof entry.controller !== "string"
  ) {
    return false;
  }
  if (
    entry.publicKeyMultibase !== undefined &&
    typeof entry.publicKeyMultibase !== "string"
  ) {
    return false;
  }
  if (
    entry.publicKeyJwk !== undefined &&
    (entry.publicKeyJwk === null ||
      typeof entry.publicKeyJwk !== "object" ||
      Array.isArray(entry.publicKeyJwk))
  ) {
    return false;
  }
  return true;
}
```

```ts
// did-web.ts — findVerificationMethod, replacing the final branch
    if (resolved === id) {
      return isVerificationMethodShape(entry as JsonObject)
        ? (entry as JsonObject as VerificationMethod)
        : undefined;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/vc did-web`
Expected: PASS (full file — confirms all pre-existing well-formed-entry cases still resolve correctly).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/vc": patch
---

Add a real runtime type guard to `findVerificationMethod` instead of blind-
casting an attacker-reachable DID document entry to `VerificationMethod`.
```

```bash
git add packages/vc/src/did-web.ts packages/vc/src/did-web.test.ts .changeset/vc-verification-method-guard.md
git commit -m "fix(vc): add runtime type guard for DID verification method entries"
```

---

### Task 16: webdav — wrap the top-level handler in try/catch (MEDIUM)

**Files:**
- Modify: `packages/webdav/src/webdav.ts:289-317` (`createWebdav`'s returned `webdav` function)
- Test: `packages/webdav/src/webdav.test.ts`

**Interfaces:**
- Consumes: existing `problem(status: number, message: string): Response` (`webdav.ts:164-173`, plain-text `Content-Type: text/plain; charset=utf-8` — the file's established convention for a generic status error, as opposed to `xml()` which is reserved for errors carrying a DAV-specific structured body).
- Produces: none new.

- [ ] **Step 1: Write the failing test**

```ts
it("returns a well-formed 500 instead of throwing when the backend throws unexpectedly", async () => {
  const backend: WebdavBackend = {
    ...baseBackend,
    stat: () => {
      throw new Error("unexpected backend failure");
    },
  };
  const handler = createWebdav({ backend });
  const res = await handler(
    new Request("https://dav.test/file.txt", { method: "PROPFIND" }),
    env,
  );
  expect(res.status).toBe(500);
  expect(res.headers.get("DAV")).toBe("1, 2");
  expect(await res.text()).not.toBe("");
});
```

(Match the exact `WebdavBackend` fixture shape and construction helper already used in `webdav.test.ts` — replace `baseBackend`/the specific method stubbed with whatever the file's existing fixtures call it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/webdav webdav -t "well-formed 500"`
Expected: FAIL — the thrown `Error` propagates out of `createWebdav`'s handler as an unhandled rejection rather than resolving to a `Response`.

- [ ] **Step 3: Wrap dispatch**

```ts
// webdav.ts
  return async function webdav(request, env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      // An unexpected backend exception must still answer as a well-formed
      // DAV response (every reply carries `DAV: 1, 2` etc. per spec) rather
      // than escape as a bare crash from the composing Worker.
      console.error("@dwk/webdav: unexpected error", error);
      response = problem(500, "Internal Server Error");
    }
    if (request.body !== null && !request.bodyUsed) {
      // ...unchanged body-drain logic...
    }
    return response;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/webdav`
Expected: PASS (full package — confirms the pre-existing `mapWriteError`-driven error tests, e.g. `PreconditionFailed`/`ResourceConflict`, are unaffected since those already resolve to a `Response` before reaching this new catch).

- [ ] **Step 5: Changeset + commit**

```markdown
---
"@dwk/webdav": patch
---

Wrap the top-level handler in try/catch so an unexpected backend exception
returns a well-formed DAV 500 response instead of escaping as a non-DAV
crash.
```

```bash
git add packages/webdav/src/webdav.ts packages/webdav/src/webdav.test.ts .changeset/webdav-error-contract.md
git commit -m "fix(webdav): return a well-formed 500 instead of throwing"
```

---

### Task 17: remotestorage — log unexpected DO storage errors (MEDIUM)

**Files:**
- Modify: `packages/remotestorage/src/log.ts` (add one event constant)
- Modify: `packages/remotestorage/src/storage.ts:107-129` (`RemoteStorageObject.fetch`'s catch-all)
- Test: `packages/remotestorage/src/index.test.ts` (the only file that currently exercises `RemoteStorageObject` — no `storage.test.ts` exists)

**Interfaces:**
- Consumes: none new (deliberately does **not** attempt to thread the front door's injected `Logger`/`Metrics` across the DO `fetch()` boundary — functions don't survive `JSON.stringify`, which is how config already crosses that boundary elsewhere in this package. `console.error` is the only signal that can reach the DO side, matching the precedent in `@dwk/activitypub`'s `object.ts` `#logDelivery`).
- Produces: new `RemoteStorageLogEvent.StorageError` constant.

- [ ] **Step 1: Write the failing test**

```ts
it("logs an unexpected storage error before rethrowing it", async () => {
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const stub = freshStub();
  const store = /* seed a backend that throws a plain Error on GET, matching
                   whatever fixture pattern index.test.ts already uses to
                   force a failure inside #readDocument/#readFolder */;

  await expect(
    runInDurableObject(stub, (instance) =>
      instance.fetch(buildReq("GET", "/broken-doc", {})),
    ),
  ).rejects.toThrow("unexpected");

  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining("RemoteStorageLogEvent"),
  );
  logSpy.mockRestore();
});
```

(Read `index.test.ts` first to find its existing method of forcing an unrecognized error out of `#readDocument`/`#readFolder`/`#putDocument`/`#deleteDocument` — reuse that fixture instead of inventing a new failure path.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/remotestorage index -t "unexpected storage error"`
Expected: FAIL — today's catch-all rethrows silently with no `console.error` call.

- [ ] **Step 3: Add the log event**

```ts
// log.ts — add alongside the existing event constants
  /** An unexpected error escaped the Durable Object's request handling.
   * Field: `method`. */
  StorageError = "remotestorage.storage.error",
```

- [ ] **Step 4: Log before rethrowing**

```ts
// storage.ts
import { RemoteStorageLogEvent } from "./log.js";
// ...
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        return text(412, "Precondition Failed");
      }
      if (error instanceof LengthRequiredError) {
        return text(411, "Length Required");
      }
      // The DO cannot reach the front door's injected Logger/Metrics across
      // the stub.fetch() boundary (functions don't survive the JSON.stringify
      // config already crosses it with) — reproduce @dwk/log's consoleLogger
      // record shape so an unexpected storage error is still visible via
      // `wrangler tail` instead of vanishing into a bare rethrow.
      console.error(
        JSON.stringify({
          level: "error",
          event: RemoteStorageLogEvent.StorageError,
          time: new Date().toISOString(),
          method,
        }),
      );
      throw error;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --project @dwk/remotestorage`
Expected: PASS (full package).

- [ ] **Step 6: Changeset + commit**

```markdown
---
"@dwk/remotestorage": patch
---

Log an unexpected Durable Object storage error via `console.error` (in the
`@dwk/log` `consoleLogger` record shape) before rethrowing it, instead of the
error vanishing silently — the front door's injected `Logger`/`Metrics`
cannot cross the DO `fetch()` boundary, so this is the only signal available
at that layer.
```

```bash
git add packages/remotestorage/src/log.ts packages/remotestorage/src/storage.ts packages/remotestorage/src/index.test.ts .changeset/remotestorage-log-storage-errors.md
git commit -m "fix(remotestorage): log unexpected DO storage errors before rethrowing"
```

---

### Task 18: atproto-pds — cap `#importRepo`'s CAR buffering (MEDIUM)

**Files:**
- Modify: `packages/atproto-pds/src/config.ts` (add `maxImportCarSizeBytes`, mirroring `maxBlobSizeBytes` at lines 99/137/163/169/220/244)
- Modify: `packages/atproto-pds/src/object.ts:1194-1201` (`#importRepo`)
- Test: `packages/atproto-pds/src/index.test.ts` (around the existing `importRepo` test at line 894)

**Interfaces:**
- Consumes: existing `namedError(status, errorName, message?): XrpcError` (`xrpc.ts:41-47`).
- Produces: `AtprotoPdsConfig.maxImportCarSizeBytes?: number` (new, optional, defaults to 128 MiB), threaded onto `ResolvedConfig` and `ForwardedConfig` identically to `maxBlobSizeBytes`.

- [ ] **Step 1: Write the failing test**

Add near the existing `importRepo` test (`index.test.ts:894`):

```ts
it("rejects an oversized migration CAR by declared Content-Length before buffering it", async () => {
  const config = createAtprotoPds({
    /* ...existing base fixture... */
    maxImportCarSizeBytes: 1024,
  });
  const oversizedCar = new Uint8Array(2048);
  const res = await config(
    new Request("https://pds.test/xrpc/com.atproto.repo.importRepo", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-test-token",
        "content-length": "2048",
      },
      body: oversizedCar,
    }),
    env,
    testCtx,
  );
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("CarTooLarge");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/atproto-pds index -t "oversized migration CAR"`
Expected: FAIL — `maxImportCarSizeBytes` doesn't exist in config yet, and `#importRepo` buffers unconditionally.

- [ ] **Step 3: Add the config field, mirroring `maxBlobSizeBytes`**

```ts
// config.ts — AtprotoPdsConfig, near maxBlobSizeBytes (~line 99)
  /** Maximum accepted migration-CAR size in bytes. Defaults to 128 MiB. */
  readonly maxImportCarSizeBytes?: number;
```

```ts
// config.ts — ResolvedConfig (~line 137)
  readonly maxImportCarSizeBytes: number;
```

```ts
// config.ts — ForwardedConfig (~line 163)
  readonly maxImportCarSizeBytes: number;
```

```ts
// config.ts — near DEFAULT_MAX_BLOB (~line 169)
const DEFAULT_MAX_IMPORT_CAR = 128 * 1024 * 1024;
```

```ts
// config.ts — resolveConfig (~line 220) and forwardedConfig (~line 244)
    maxImportCarSizeBytes: config.maxImportCarSizeBytes ?? DEFAULT_MAX_IMPORT_CAR,
// ...
    maxImportCarSizeBytes: config.maxImportCarSizeBytes,
```

- [ ] **Step 4: Cap `#importRepo`, mirroring `#uploadBlob`**

```ts
// object.ts — #importRepo
  async #importRepo(request: Request): Promise<Response> {
    await this.#requireAuth(request, ACCESS_SCOPE);
    const did = this.#accountDid();
    const verifyKey = await resolveSigningKey(did, {
      plcDirectoryUrl: this.#cfg.plcDirectoryUrl,
    });
    // Reject an oversized migration CAR by its declared length *before*
    // buffering it, so a hostile Content-Length cannot push the DO past its
    // 128 MB ceiling (mirrors #uploadBlob).
    const declared = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declared) &&
      declared > this.#cfg.maxImportCarSizeBytes
    ) {
      throw namedError(400, "CarTooLarge", "Import CAR exceeds the size limit");
    }
    const carBytes = new Uint8Array(await request.arrayBuffer());
    if (carBytes.length > this.#cfg.maxImportCarSizeBytes) {
      throw namedError(400, "CarTooLarge", "Import CAR exceeds the size limit");
    }
    const imported = await importRepoFromCar(carBytes, { verifyKey });
    // ...unchanged...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --project @dwk/atproto-pds`
Expected: PASS (full package — confirms the existing `importRepo` success-path test still works with the new default cap, which is well above any test fixture's CAR size).

- [ ] **Step 6: Changeset + commit**

```markdown
---
"@dwk/atproto-pds": patch
---

Reject an oversized migration CAR by its declared `Content-Length` before
buffering it in `#importRepo`, mirroring the existing `#uploadBlob` size
check instead of buffering an unbounded body.
```

```bash
git add packages/atproto-pds/src/config.ts packages/atproto-pds/src/object.ts packages/atproto-pds/src/index.test.ts .changeset/atproto-pds-cap-import-car.md
git commit -m "fix(atproto-pds): cap migration CAR size before buffering"
```

---

### Task 19: atproto-pds — surface unhandled XRPC errors (MEDIUM)

**Files:**
- Modify: `packages/atproto-pds/src/xrpc.ts:58-69` (`errorResponse`)
- Modify: `packages/atproto-pds/src/handler.ts:57-74` (`forwardToDo`)
- Test: `packages/atproto-pds/src/xrpc.test.ts:21-27`, `packages/atproto-pds/src/index.test.ts` (for the front-door log assertion)

**Interfaces:**
- Consumes: existing `config.logger: Logger` / `config.metrics: Metrics` on `ResolvedConfig` (already defaulted to noop, currently unused anywhere in the package).
- Produces: none new — this deliberately does **not** add a `logger`/`metrics` field to `ForwardedConfig` (functions cannot survive the `JSON.stringify` that already carries config across the DO `fetch()` boundary); instead the DO side gets a `console.error` (always-visible, matching the `@dwk/activitypub` `object.ts` `#logDelivery` precedent) and the front door — which still holds the real injected seams — logs an aggregate signal whenever the DO returns a `500`.

- [ ] **Step 1: Write the failing test (DO-side console.error)**

Add to `xrpc.test.ts`, alongside the existing `"maps unknown errors to 500"` case:

```ts
it("logs the underlying error before mapping it to a generic 500", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = errorResponse(new TypeError("something broke internally"));
  expect(res.status).toBe(500);
  expect(spy).toHaveBeenCalledWith(
    expect.stringContaining("unhandled XRPC error"),
    expect.any(TypeError),
  );
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/atproto-pds xrpc -t "logs the underlying error"`
Expected: FAIL — `errorResponse` currently has no `console.error` call.

- [ ] **Step 3: Log in `errorResponse`**

```ts
// xrpc.ts
export function errorResponse(error: unknown): Response {
  if (error instanceof XrpcError) {
    return jsonResponse(
      { error: error.errorName, message: error.message },
      error.status,
    );
  }
  // Unexpected errors are otherwise invisible: the DO only ever gets a
  // no-op logger forwarded across the fetch() boundary (functions don't
  // survive JSON.stringify), so console.error here is the only surviving
  // signal at this layer.
  console.error("@dwk/atproto-pds: unhandled XRPC error", error);
  return jsonResponse(
    { error: "InternalServerError", message: "Internal server error" },
    500,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/atproto-pds xrpc`
Expected: PASS.

- [ ] **Step 5: Write the failing test (front-door aggregate log)**

Add to `index.test.ts`:

```ts
it("logs an aggregate event on the front door when the DO returns a 500", async () => {
  const logged: Array<[string, unknown]> = [];
  const handler = createAtprotoPds({
    /* ...existing base fixture, forcing a route that throws a non-XrpcError
       inside the DO, e.g. an existing test fixture already used elsewhere in
       this file for a 500 case... */
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (event, fields) => logged.push([event, fields]),
    },
  });
  const res = await handler(forceInternalErrorRequest(), env, testCtx);
  expect(res.status).toBe(500);
  expect(logged).toContainEqual([
    "atproto_pds.xrpc.internal_error",
    expect.objectContaining({ path: expect.any(String) }),
  ]);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test --project @dwk/atproto-pds index -t "aggregate event"`
Expected: FAIL — `forwardToDo` doesn't inspect the response status today.

- [ ] **Step 7: Log on the front door for any 500 from the DO**

```ts
// handler.ts
async function forwardToDo(
  config: ResolvedConfig,
  env: AtprotoPdsEnv,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_CONFIG_HEADER, JSON.stringify(forwardedConfig(config)));
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : request.body,
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit);
  const response = await repoStub(config, env).fetch(forwarded);
  // The DO cannot hold the injected logger/metrics across the fetch()
  // boundary (see xrpc.ts's errorResponse) — this is where the real seams
  // are still in scope, so an aggregate signal is recorded here instead. The
  // response body only ever carries the generic "Internal server error"
  // message (see errorResponse), so there is no real detail to forward — the
  // path is the only useful dimension available at this layer.
  if (response.status === 500) {
    config.logger.error("atproto_pds.xrpc.internal_error", {
      path: new URL(request.url).pathname,
    });
    config.metrics.count("atproto_pds.xrpc.internal_error");
  }
  return response;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test --project @dwk/atproto-pds`
Expected: PASS (full package).

- [ ] **Step 9: Changeset + commit**

```markdown
---
"@dwk/atproto-pds": patch
---

Log unhandled XRPC errors: `console.error` at the Durable Object layer (the
only signal that survives the fetch() boundary) and an aggregate
`logger`/`metrics` event at the front door, where the real injected seams are
still in scope, whenever the DO returns a 500.
```

```bash
git add packages/atproto-pds/src/xrpc.ts packages/atproto-pds/src/handler.ts packages/atproto-pds/src/xrpc.test.ts packages/atproto-pds/src/index.test.ts .changeset/atproto-pds-log-xrpc-errors.md
git commit -m "fix(atproto-pds): surface unhandled XRPC errors via logging"
```

---

### Task 20: conformance-target — fix timing-safe-equal length leak (MEDIUM)

**Files:**
- Modify: `packages/conformance-target/src/timing-safe-equal.ts:6-12`
- Test: `packages/conformance-target/src/timing-safe-equal.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `timingSafeEqual(a: string, b: string): boolean` — signature unchanged (stays synchronous, since `crypto.subtle.timingSafeEqual` is not a `Promise`-returning API), so call sites in `admin.ts`/`approval.ts` need **no** edits.

- [ ] **Step 1: Write the failing test**

```ts
it("uses crypto.subtle.timingSafeEqual under the hood", () => {
  const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
  timingSafeEqual("same-length-a", "same-length-b");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/conformance-target timing-safe-equal -t "under the hood"`
Expected: FAIL — today's implementation loops to `Math.min(a.length, b.length)` and never calls the primitive.

- [ ] **Step 3: Implement using the Cloudflare-documented pattern**

```ts
// timing-safe-equal.ts
/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Do not short-circuit on length — looping
 * only to `Math.min(a.length, b.length)` leaks the shorter length via
 * timing; compare the value against itself instead when lengths differ, per
 * Cloudflare's documented safe pattern.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS (full package — grep `admin.ts`/`approval.ts` for call sites first to confirm neither expects an `async` function; the research pass found no such expectation, but re-verify at implementation time since this package composes several conformance suites).

- [ ] **Step 5: Changeset + commit**

`@dwk/conformance-target` is a deployed target, not published to npm — check `conformance-target/package.json`'s `"private"` field before writing a changeset; if private, skip the changeset (matching the `examples/deploy-to-cloudflare` precedent in Task 22) and note it in the PR body's checklist instead.

```bash
git add packages/conformance-target/src/timing-safe-equal.ts packages/conformance-target/src/timing-safe-equal.test.ts
git commit -m "fix(conformance-target): use crypto.subtle.timingSafeEqual, avoid length leak"
```

---

### Task 21: conformance-target — wrap `fetch()` in try/catch (MEDIUM)

**Files:**
- Modify: `packages/conformance-target/src/index.ts:42-56`
- Test: a new or existing `packages/conformance-target/src/index.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: none new — this package's mounts already answer with plain-text `new Response("...", {status})` (confirmed: `admin.ts:50,53`, `approval.ts:231,240,250`, `home.ts:130`), so the fallback matches that convention, not a JSON envelope.

- [ ] **Step 1: Write the failing test**

```ts
it("returns a plain-text 500 instead of throwing when routeRequest throws", async () => {
  const worker = { fetch: /* the exported default */ } as ExportedHandler<Env>;
  const badRequest = new Request("https://conformance.test/force-throw");
  // Use whatever existing seam this package's tests already have for forcing
  // routeRequest to throw (e.g. a malformed env binding) rather than adding
  // a new one.
  const res = await worker.fetch!(badRequest, brokenEnv, testCtx);
  expect(res.status).toBe(500);
  expect(await res.text()).toBe("Internal Server Error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --project @dwk/conformance-target index -t "plain-text 500"`
Expected: FAIL — the thrown error propagates unhandled.

- [ ] **Step 3: Wrap dispatch**

```ts
// index.ts
async fetch(request, env, ctx): Promise<Response> {
    try {
      mounts ??= buildMounts(env);
      const response = await routeRequest(mounts, request, env, ctx);
      if (request.body !== null && !request.bodyUsed) {
        request.body.cancel().catch(() => undefined);
      }
      return response;
    } catch (error) {
      console.error("@dwk/conformance-target: unhandled fetch error", error);
      return new Response("Internal Server Error", { status: 500 });
    }
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --project @dwk/conformance-target`
Expected: PASS (full package).

- [ ] **Step 5: Commit (no changeset — private package, per Task 20's note)**

```bash
git add packages/conformance-target/src/index.ts packages/conformance-target/src/index.test.ts
git commit -m "fix(conformance-target): wrap fetch dispatch in try/catch"
```

---

### Task 22: examples/deploy-to-cloudflare — fix the `Env` type to cover both mounted packages (MEDIUM)

**Files:**
- Modify: `examples/deploy-to-cloudflare/src/index.ts:114` (and its import block)
- No test file exists for this directory (no test tooling configured) — verify with `tsc --noEmit`.

**Interfaces:**
- Consumes: existing `WebfingerEnv` (`packages/webfinger/src/handler.ts:25`, `Record<never, never>`), existing `HostMetaEnv` (`packages/host-meta/src/handler.ts:25`, `Record<never, never>`).
- Produces: none new — type-only change.

- [ ] **Step 1: Confirm the current (harmless-today, trap-tomorrow) gap**

```bash
grep -n "ExportedHandler\|WebfingerEnv\|HostMetaEnv" examples/deploy-to-cloudflare/src/index.ts
```

Confirm line 114 currently reads `} satisfies ExportedHandler<WebfingerEnv>;` while `env` is also passed to `hostMeta(request, env, ctx)` a few lines above (line ~107) — i.e., `env`'s type only covers one of the two handlers it's actually passed to.

- [ ] **Step 2: Run typecheck to establish the baseline (this is a type-only fix, so "test" = typecheck)**

Run: `pnpm --filter dwk-discovery-starter check`
Expected: PASS today (both fragments are `Record<never, never>`, so nothing currently fails) — this step is a baseline, not a red/green TDD cycle, since there is no runtime test harness for this directory.

- [ ] **Step 3: Fix the type**

```ts
// index.ts — import block
import { createHostMeta, type HostMetaEnv } from "@dwk/host-meta";
import { createWebfinger, type WebfingerEnv } from "@dwk/webfinger";
```

```ts
// index.ts — line 114
} satisfies ExportedHandler<WebfingerEnv & HostMetaEnv>;
```

(An intersection, not a union: `env` must satisfy both packages' requirements simultaneously, since the same `env` value is passed to both `webfinger(...)` and `hostMeta(...)`.)

- [ ] **Step 4: Run typecheck to verify it still passes**

Run: `pnpm --filter dwk-discovery-starter check`
Expected: PASS (both fragments are still empty today, so the intersection is still `Record<never, never>` — this change only pays off the next time a package with a real binding is added to this starter, at which point the type will correctly demand it in `env`).

- [ ] **Step 5: Commit (no changeset — `"private": true`)**

```bash
git add examples/deploy-to-cloudflare/src/index.ts
git commit -m "fix(deploy-to-cloudflare): type env against both mounted packages"
```

---

## After all 22 tasks

Run the full local CI gate once, matching `.github/workflows/ci.yml`'s order, before opening a PR (or PRs — 22 independent fixes across 13 packages may be more reviewable as several smaller PRs grouped by package family, e.g. "webauthn fixes", "solid-oidc fixes", "timing-safe-equal fixes across 4 packages", rather than one 22-commit PR; ask the user which grouping they want before pushing):

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test
```

Update `conformance/status.json` only if any task changed integration/conformance posture (none of these 22 fixes do — they are all bug fixes with no lifecycle or conformance-suite behavior change) — leave the PR checklist item unchecked with `- [ ] Updated conformance/status.json — not applicable, no conformance/integration behavior changed` per this repo's PR template convention.
