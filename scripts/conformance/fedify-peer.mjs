/**
 * Fedify-based ActivityPub interop peer (issue #246).
 *
 * A second, automatable federation implementation to test @dwk/activitypub
 * against — cheaper to run in CI than a full Mastodon instance. This spins up
 * an ephemeral Fedify actor (`peer`), points it at a deployed
 * `@dwk/activitypub` actor (`--target`), and drives the interop cases from
 * the issue:
 *
 *   - `webfinger` — resolve the target's WebFinger + actor document and check
 *     the FEP-2c59 `webfinger` back-link (§ "actor & collections" in
 *     spec/packages/activitypub.md). Read-only; no callback needed.
 *   - `follow`    — send a signed `Follow`, wait for the auto-`Accept` to
 *     arrive at the peer's inbox.
 *   - `activities` — send `Create` / `Like` / `Announce` / `Undo(Like)`, then
 *     redeliver the `Create` to check the target doesn't error on a repeat
 *     delivery. (Byte-for-byte no-duplicate-side-effect dedup is verified by
 *     the package's own DO tests, not observable from outside over HTTP.)
 *   - `fanout`    — after `follow` succeeds, trigger the owner to publish (via
 *     `--publish-trigger <url>`, POSTed with no body) and wait for the fanned-
 *     out `Create` to arrive at the peer's inbox.
 *   - `rsvp`      — send `Join`/`Leave` against an owned event (`--event
 *     <actor-url>`).
 *
 * Every send goes through Fedify's own HTTP Signatures implementation, which
 * double-knocks (tries one spec, falls back to the other between RFC 9421 and
 * draft-cavage) and remembers which spec a peer accepted — so exercising any
 * case here already exercises the "implements both signature specs" half of
 * the issue's motivation. There is no separate double-knock case.
 *
 * Callback requirement: every case except `webfinger` needs the target to be
 * able to deliver back to this peer's inbox, i.e. `--peer-url` must be a
 * publicly reachable URL that forwards to this process's `--port`. A
 * Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:8765`,
 * no account needed) keeps the "no third-party hosted service" property from
 * the issue, since Cloudflare is already this project's deploy target — but
 * any tunnel that forwards HTTP works. Without `--peer-url`, only `webfinger`
 * runs; the rest are reported `skipped` (loudly, with the reason), never
 * silently omitted.
 *
 * Usage:
 *   node scripts/conformance/fedify-peer.mjs \
 *     --target <actor-url> \
 *     [--peer-url <public-base-url>] [--port 8765] \
 *     [--case webfinger,follow,activities,page,announce-unwrap,fanout,rsvp] \
 *     [--publish-trigger <url>] [--event <event-actor-url>] \
 *     [--publish-url <target-outbox-url> --publish-token <token>] \
 *     [--timeout 15000]
 *
 * The `announce-unwrap` case (FEP-1b12 group relay) additionally needs the
 * target's owner publish endpoint (`--publish-url`, its `POST <actor>/outbox`
 * URL) and bearer token (`--publish-token`, or `FEDIFY_PUBLISH_TOKEN`) so the
 * target can be made to follow this peer's `Group` actor; without them the
 * case is reported `skipped`, never silently omitted.
 *
 * Exports `runInterop` so `run-suite.mjs` can drive this in-process.
 */

import { createServer } from "node:http";
import { argv, env, exit, stdout, stderr } from "node:process";
import {
  createFederation,
  MemoryKvStore,
  generateCryptoKeyPair,
} from "@fedify/fedify";
import {
  Person,
  Group,
  Follow,
  Accept,
  Create,
  Like,
  Announce,
  Undo,
  Join,
  Leave,
  Note,
  Page,
  Endpoints,
} from "@fedify/vocab";

const IDENTIFIER = "peer";
/** The second actor this peer serves: a FEP-1b12 `Group` (community) the
 * target can follow, for the announce-unwrap case. */
const GROUP_IDENTIFIER = "group";
export const ALL_CASES = [
  "webfinger",
  "follow",
  "activities",
  "page",
  "announce-unwrap",
  "fanout",
  "rsvp",
];
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

/** Build the ephemeral peer's Federation object: one actor, an in-memory KV
 * store (this is a throwaway test double, not the production package — the
 * "never KV for authoritative state" rule in
 * spec/non-functional-requirements.md governs @dwk/activitypub itself, not
 * this disposable interop tool), and inbox listeners that just record what
 * arrives for the case runners below to poll. */
async function buildPeer(peerUrl) {
  const keyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const groupKeyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const received = [];
  // Pages the announce-unwrap case mints, served by the object dispatcher
  // below so the target's relayed-content origin verification (§2.2) can
  // re-fetch them from this peer.
  const pages = new Map();

  const federation = createFederation({ kv: new MemoryKvStore() });

  federation
    .setActorDispatcher(`/users/{identifier}`, async (ctx, identifier) => {
      if (identifier !== IDENTIFIER && identifier !== GROUP_IDENTIFIER) {
        return null;
      }
      const keys = await ctx.getActorKeyPairs(identifier);
      const common = {
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        inbox: ctx.getInboxUri(identifier),
        // No outbox/followers collection dispatcher is registered — this peer
        // only ever receives, it never serves its own collections — so these
        // are synthesized URLs rather than `ctx.getOutboxUri()`/
        // `getFollowersUri()` (which throw without a registered dispatcher).
        outbox: new URL(`${ctx.getActorUri(identifier).href}/outbox`),
        followers: new URL(`${ctx.getActorUri(identifier).href}/followers`),
        endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
        publicKey: keys[0].cryptographicKey,
      };
      if (identifier === GROUP_IDENTIFIER) {
        // The FEP-1b12 community actor: the target follows this Group and
        // must record `actor_type = 'Group'` from this document for its
        // announce-unwrap gate (spec/fediverse-interop.md §2.1–2.2).
        return new Group({
          ...common,
          name: "dwk/workers Fedify interop community",
          summary:
            "Ephemeral FEP-1b12 Group for the announce-unwrap case; throwaway per run.",
        });
      }
      return new Person({
        ...common,
        name: "dwk/workers Fedify interop peer",
        summary:
          "Ephemeral ActivityPub interop peer for @dwk/activitypub (issue #246); throwaway per run.",
      });
    })
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      if (identifier === IDENTIFIER) return [keyPair];
      if (identifier === GROUP_IDENTIFIER) return [groupKeyPair];
      return [];
    });

  // Serve minted Pages at stable URLs so the target's async origin
  // verification of relayed content can confirm them (expect 'present').
  federation.setObjectDispatcher(Page, "/pages/{id}", (_ctx, values) => {
    return pages.get(values.id) ?? null;
  });

  federation
    .setInboxListeners(`/users/{identifier}/inbox`, "/inbox")
    .on(Accept, (_ctx, activity) => {
      received.push({ type: "Accept", activity, at: Date.now() });
    })
    .on(Create, (_ctx, activity) => {
      received.push({ type: "Create", activity, at: Date.now() });
    })
    .on(Follow, (_ctx, activity) => {
      received.push({ type: "Follow", activity, at: Date.now() });
    })
    .onError((_ctx, error) => {
      stderr.write(`peer inbox error: ${error}\n`);
    });

  const ctx = federation.createContext(new URL(peerUrl), undefined);
  return { federation, ctx, received, pages };
}

/**
 * Bridge Fedify's `federation.fetch` (a WHATWG fetch handler) onto a plain
 * `node:http` server — Fedify ships no Node HTTP adapter of its own.
 *
 * Trusts `X-Forwarded-Proto` (which cloudflared sets on every request it
 * proxies) rather than hardcoding `http:`, falling back to `peerUrl`'s own
 * scheme when the header is absent — self-enforcing against whatever
 * `buildPeer`'s fixed signing context actually uses, rather than assuming
 * "always https" as a bare default that would silently drift out of sync if
 * this script ever grows a plain-HTTP/no-tunnel mode. Getting this wrong
 * caused a real, reproduced bug (issue #273/#315/#317/#318): this peer's actor
 * document, self-describing its `id`/`publicKey.owner` from the *inbound*
 * request's reconstructed URL, came out `http://…` (the plain-HTTP scheme
 * cloudflared uses for its local leg to `localhost:{port}`) while the same
 * peer's *outbound* signed activities carried `actor: https://…` (built from
 * the fixed context in `buildPeer`) — two different self-identities for one
 * actor, depending on direction. The target's anti-impersonation check
 * (rightly) rejected every delivery as a mismatch.
 */
function serve(federation, port, peerUrl) {
  const defaultProto = new URL(peerUrl).protocol.replace(/:$/, "");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const proto = req.headers["x-forwarded-proto"] ?? defaultProto;
      const url = `${proto}://${req.headers.host ?? `localhost:${port}`}${req.url}`;
      const request = new Request(url, {
        method: req.method,
        headers: new Headers(
          Object.entries(req.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : Array.isArray(value)
                ? value.map((v) => [key, v])
                : [[key, value]],
          ),
        ),
        body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body,
      });
      try {
        const response = await federation.fetch(request, {
          contextData: undefined,
          onNotFound: () => new Response("Not Found", { status: 404 }),
        });
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        stderr.write(`peer server error: ${error?.stack ?? error}\n`);
        res.writeHead(500).end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

const TUNNEL_WARMUP_TIMEOUT_MS = 10_000;
const TUNNEL_WARMUP_POLL_MS = 500;

/**
 * Poll the peer's own actor endpoint back through the public `peerUrl` until
 * it responds, before letting any case run that depends on the *target*
 * fetching back through the tunnel (issue #273/#315: a live run's `follow`
 * case failed `key_unresolved` — the target's key resolver tried to fetch
 * this peer's actor document immediately after the Quick Tunnel came up, and
 * the fetch failed). cloudflared logging its assigned hostname locally
 * doesn't mean that hostname is yet routable from every Cloudflare edge
 * location; round-tripping a real request through the same public hostname is
 * the best signal available from here that routing has propagated. It is not
 * airtight — the target's own fetch happens from Cloudflare's Worker network,
 * a different vantage point than this runner — but Quick Tunnel hostnames
 * register centrally rather than per-PoP, so a success here is strong
 * evidence the target's fetch will also succeed. Best-effort: logs and
 * proceeds either way rather than failing the run, so a stubborn tunnel
 * degrades to today's (still occasionally flaky) behavior instead of a new
 * hard failure mode.
 */
async function waitForTunnelReady(peerUrl, log) {
  const deadline = Date.now() + TUNNEL_WARMUP_TIMEOUT_MS;
  const probeUrl = `${peerUrl}/users/${IDENTIFIER}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, {
        headers: { accept: "application/activity+json" },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        log(`Quick Tunnel warm: ${peerUrl} is routable`);
        return;
      }
    } catch {
      // Not yet routable (DNS/connection failure through the tunnel); retry.
    }
    await new Promise((r) => setTimeout(r, TUNNEL_WARMUP_POLL_MS));
  }
  log(
    `::warning::Quick Tunnel did not confirm routable within ${TUNNEL_WARMUP_TIMEOUT_MS}ms; proceeding anyway`,
  );
}

async function waitFor(received, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

function activityId(activity) {
  return activity?.id?.href ?? null;
}

async function caseWebfinger({ ctx, target, log }) {
  // Resolve via Fedify's normal stack first — proves a real Fedify peer's
  // ordinary actor-resolution path (which itself may go through WebFinger)
  // succeeds against the deployed target.
  const actor = await ctx.lookupObject(target);
  if (!actor || actor.id?.href !== new URL(target).href) {
    throw new Error(
      `lookupObject(${target}) did not resolve to that actor (got ${actor?.id?.href ?? actor})`,
    );
  }

  // The actor states its own FEP-2c59 back-link (`webfinger`); read that
  // rather than guessing `user@host`, since `acctDomain` may differ from the
  // actor URL's hostname (spec/packages/activitypub.md).
  const raw = await fetch(target, {
    headers: { accept: "application/activity+json" },
  });
  if (!raw.ok) {
    throw new Error(
      `fetching the actor failed: ${raw.status} ${raw.statusText}`,
    );
  }
  const rawActor = await raw.json();
  const backLink = rawActor.webfinger;
  if (typeof backLink !== "string" || !backLink.startsWith("acct:")) {
    throw new Error(
      `actor is missing a FEP-2c59 'webfinger' back-link (got ${JSON.stringify(backLink)})`,
    );
  }
  const [, , acctDomain] = /^acct:([^@]+)@(.+)$/.exec(backLink) ?? [];
  if (!acctDomain) {
    throw new Error(`could not parse acct domain out of '${backLink}'`);
  }

  const targetUrl = new URL(target);
  const wf = await fetch(
    `${targetUrl.protocol}//${acctDomain}/.well-known/webfinger?resource=${encodeURIComponent(backLink)}`,
  );
  if (!wf.ok) {
    throw new Error(`WebFinger lookup for '${backLink}' failed: ${wf.status}`);
  }
  const doc = await wf.json();
  const self = (doc.links ?? []).find(
    (l) => l.rel === "self" && l.type?.includes("activity+json"),
  );
  if (!self || self.href !== target) {
    throw new Error(
      `WebFinger 'self' link (${self?.href}) does not match the actor URL (${target})`,
    );
  }
  log(
    `actor resolves via Fedify; WebFinger '${backLink}' back-links to ${target}`,
  );
}

async function caseFollow({ ctx, target, received, timeoutMs, log }) {
  const targetActor = await ctx.lookupObject(target);
  if (!targetActor) throw new Error(`could not resolve target actor ${target}`);

  // A unique id per run: @dwk/activitypub dedups inbound activities by `id`
  // for 7 days, so a static fragment would make every rerun against the same
  // persistent target within that window a silent no-op.
  const follow = new Follow({
    id: new URL(
      `${ctx.getActorUri(IDENTIFIER).href}#follow-${crypto.randomUUID()}`,
    ),
    actor: ctx.getActorUri(IDENTIFIER),
    object: targetActor.id,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, follow, {
    immediate: true,
  });
  log(`sent Follow ${follow.id.href}`);

  // This ephemeral peer only ever sends the one Follow above, so any Accept
  // landing in its inbox during this case is necessarily the response to it.
  const accept = await waitFor(received, (r) => r.type === "Accept", timeoutMs);
  if (!accept) {
    throw new Error(
      `no Accept arrived at the peer's inbox within ${timeoutMs}ms`,
    );
  }
  log(`received signed Accept ${activityId(accept.activity) ?? "(no id)"}`);
}

async function caseActivities({ ctx, target, log }) {
  const targetActor = await ctx.lookupObject(target);
  if (!targetActor) throw new Error(`could not resolve target actor ${target}`);

  // One id per run (see the comment in caseFollow): every activity below
  // gets a distinct, run-scoped id so reruns against a persistent target
  // aren't silently swallowed by the target's 7-day activity dedup cache.
  const runId = crypto.randomUUID();
  const note = new Note({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#note-${runId}`),
    attributedTo: ctx.getActorUri(IDENTIFIER),
    content: "Fedify interop peer test note (issue #246)",
  });
  const create = new Create({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#create-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: note,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, create, {
    immediate: true,
  });
  log(`sent Create ${create.id.href}`);

  const like = new Like({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#like-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: note.id,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, like, {
    immediate: true,
  });
  log(`sent Like ${like.id.href}`);

  const announce = new Announce({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#announce-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: note.id,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, announce, {
    immediate: true,
  });
  log(`sent Announce ${announce.id.href}`);

  const undo = new Undo({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#undo-like-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: like,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, undo, {
    immediate: true,
  });
  log(`sent Undo(Like) ${undo.id.href}`);

  // Redeliver the same Create (same activity id): the target must accept it
  // again without erroring. This confirms redelivery doesn't crash the
  // target; it does NOT independently prove no duplicate side effect landed
  // (that's covered by @dwk/activitypub's own DO integration tests, which can
  // see internal state this external peer cannot).
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, create, {
    immediate: true,
  });
  log(`redelivered the same Create without error (dedup smoke check)`);
}

/**
 * Threadiverse content shape (fediverse interop #273 phase 2): deliver a
 * signed `Create` wrapping a titled `Page` — the Lemmy top-level-post shape —
 * and redeliver it to confirm the classification path tolerates dedup. Like
 * `activities`, acceptance-without-error is the externally observable
 * contract; the stored `object_type`/`audience` classification is covered by
 * the package's own DO tests. (The group-relay `Announce`-unwrap case needs
 * this peer to serve a `Group` actor the target follows — tracked in #280.)
 */
async function casePage({ ctx, target, log }) {
  const targetActor = await ctx.lookupObject(target);
  if (!targetActor) throw new Error(`could not resolve target actor ${target}`);

  const runId = crypto.randomUUID();
  const page = new Page({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#page-${runId}`),
    attributedTo: ctx.getActorUri(IDENTIFIER),
    name: "Fedify interop peer test page (fediverse interop #273)",
    content: "A titled Page — the Lemmy/threadiverse top-level post shape.",
  });
  const create = new Create({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#create-page-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: page,
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, create, {
    immediate: true,
  });
  log(`sent Create(Page) ${create.id.href}`);

  await ctx.sendActivity({ identifier: IDENTIFIER }, targetActor, create, {
    immediate: true,
  });
  log(`redelivered the same Create(Page) without error (dedup smoke check)`);
}

/**
 * FEP-1b12 group relay, end to end over real HTTP signatures
 * (spec/fediverse-interop.md §2.1–2.3):
 *
 *   1. make the TARGET follow this peer's `Group` actor, via the target's
 *      owner publish endpoint (`--publish-url` = `POST <actor>/outbox`,
 *      `--publish-token` = its bearer token) — the target queues the Follow,
 *      resolves the Group's actor document (recording `actor_type: Group`),
 *      and delivers the signed Follow to the group's inbox here;
 *   2. the group `Accept`s, so the target marks the follow accepted;
 *   3. the group `Announce`s a member's `Create(Page)` — the FEP-1b12
 *      envelope — to the target, which must accept it (202) and unwrap.
 *
 * The unwrapped inner activity's storage (`relayed_by`, inner-id dedup) is
 * internal DO state covered by the package's own tests; what this case
 * proves externally is the full follow → accept → announce lifecycle over
 * signed HTTP, plus origin verification: the announced Page is served by
 * this peer's object dispatcher, so the target's async verification tier can
 * re-fetch it.
 */
async function caseAnnounceUnwrap({
  ctx,
  target,
  received,
  pages,
  publishUrl,
  publishToken,
  timeoutMs,
  log,
}) {
  if (!publishUrl || !publishToken) {
    log(
      "skipped: --publish-url/--publish-token not given, so the target cannot be made to follow the peer's Group",
    );
    return "skipped";
  }
  const targetActor = await ctx.lookupObject(target);
  if (!targetActor) throw new Error(`could not resolve target actor ${target}`);
  const groupUri = ctx.getActorUri(GROUP_IDENTIFIER);
  const memberUri = ctx.getActorUri(IDENTIFIER);
  const runId = crypto.randomUUID();

  // 1. Owner-publish a Follow of the peer group on the target.
  const followResponse = await fetch(publishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${publishToken}`,
      "content-type": "application/activity+json",
    },
    body: JSON.stringify({ type: "Follow", object: groupUri.href }),
  });
  if (!followResponse.ok) {
    throw new Error(
      `owner publish of the Follow failed: ${followResponse.status}`,
    );
  }
  log(`target owner-published a Follow of ${groupUri.href}`);

  const follow = await waitFor(received, (r) => r.type === "Follow", timeoutMs);
  if (!follow) {
    throw new Error(
      `no signed Follow arrived at the group's inbox within ${timeoutMs}ms — did the target's delivery alarm run?`,
    );
  }
  log(`group received signed Follow ${activityId(follow.activity) ?? ""}`);

  // 2. Accept it as the group, so the target marks the follow accepted.
  const accept = new Accept({
    id: new URL(`${groupUri.href}#accept-${runId}`),
    actor: groupUri,
    object: follow.activity,
  });
  await ctx.sendActivity(
    { identifier: GROUP_IDENTIFIER },
    targetActor,
    accept,
    { immediate: true },
  );
  log(`group sent Accept ${accept.id.href}`);
  // The Accept travels one hop and is processed synchronously by the target's
  // inbox; a short grace keeps the Announce from racing it.
  await new Promise((r) => setTimeout(r, 2_000));

  // 3. Announce a member's Create(Page) — the FEP-1b12 envelope.
  const page = new Page({
    id: ctx.getObjectUri(Page, { id: runId }),
    attributedTo: memberUri,
    name: "Fedify interop community post (fediverse interop #273)",
    content: "A titled Page relayed by the community's Announce.",
  });
  pages.set(runId, page);
  const create = new Create({
    id: new URL(`${memberUri.href}#create-page-${runId}`),
    actor: memberUri,
    object: page,
  });
  const announce = new Announce({
    id: new URL(`${groupUri.href}#announce-${runId}`),
    actor: groupUri,
    object: create,
  });
  await ctx.sendActivity(
    { identifier: GROUP_IDENTIFIER },
    targetActor,
    announce,
    { immediate: true },
  );
  log(
    `group sent Announce(Create(Page)) ${announce.id.href}; the target unwraps it ` +
      `(relayed_by provenance — internal state, covered by DO tests) and its ` +
      `verification tier can re-fetch ${page.id.href} from this peer`,
  );
}

async function caseFanout({
  received,
  publishTrigger,
  publishUrl,
  publishToken,
  timeoutMs,
  log,
}) {
  const before = received.length;
  if (publishTrigger) {
    const res = await fetch(publishTrigger, { method: "POST" });
    if (!res.ok) {
      throw new Error(`--publish-trigger POST failed: ${res.status}`);
    }
    log(`triggered owner publish via ${publishTrigger}`);
  } else if (publishUrl && publishToken) {
    // No bespoke trigger endpoint needed: the owner publish channel (also
    // used by announce-unwrap) publishes a bare Note, which the target wraps
    // in a Create addressed to Public + followers and fans out.
    const res = await fetch(publishUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${publishToken}`,
        "content-type": "application/activity+json",
      },
      body: JSON.stringify({
        type: "Note",
        content: `Fedify interop fanout probe ${crypto.randomUUID()}`,
      }),
    });
    if (!res.ok) {
      throw new Error(`owner publish for fanout failed: ${res.status}`);
    }
    log(`owner-published a Note via ${publishUrl}`);
  } else {
    log(
      "skipped: neither --publish-trigger nor --publish-url/--publish-token given, so nothing can make the owner publish",
    );
    return "skipped";
  }

  const arrived = await waitFor(
    received,
    (r, i) => i >= before && r.type === "Create",
    timeoutMs,
  );
  if (!arrived) {
    throw new Error(
      `no fanned-out Create arrived at the peer's inbox within ${timeoutMs}ms — is the peer an accepted follower? (run the 'follow' case first)`,
    );
  }
  log(
    `received fanned-out Create ${activityId(arrived.activity) ?? "(no id)"}`,
  );
}

async function caseRsvp({ ctx, event, received, timeoutMs, log }) {
  if (!event) {
    log("skipped: no --event actor URL given to RSVP against");
    return "skipped";
  }
  const eventActor = await ctx.lookupObject(event);
  if (!eventActor) throw new Error(`could not resolve event ${event}`);

  // Run-scoped ids, same reasoning as caseFollow/caseActivities.
  const runId = crypto.randomUUID();
  const join = new Join({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#join-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: eventActor.id ?? new URL(event),
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, eventActor, join, {
    immediate: true,
  });
  log(`sent Join ${join.id.href}`);

  const accept = await waitFor(received, (r) => r.type === "Accept", timeoutMs);
  if (!accept) {
    log(
      "no Accept arrived — acceptable if the event owner manuallyApprovesJoins; not treated as a failure",
    );
  } else {
    log(`received Accept for Join ${activityId(accept.activity) ?? "(no id)"}`);
  }

  const leave = new Leave({
    id: new URL(`${ctx.getActorUri(IDENTIFIER).href}#leave-${runId}`),
    actor: ctx.getActorUri(IDENTIFIER),
    object: eventActor.id ?? new URL(event),
  });
  await ctx.sendActivity({ identifier: IDENTIFIER }, eventActor, leave, {
    immediate: true,
  });
  log(`sent Leave ${leave.id.href}`);
}

const CASES = {
  webfinger: caseWebfinger,
  follow: caseFollow,
  activities: caseActivities,
  page: casePage,
  "announce-unwrap": caseAnnounceUnwrap,
  fanout: caseFanout,
  rsvp: caseRsvp,
};

/**
 * Run the requested interop cases against `target`. Returns
 * `{ results: Array<{ case, status: "passing"|"failing"|"skipped", detail }> }`.
 * `webfinger` never needs `peerUrl`; every other case is reported `skipped`
 * (with the reason) rather than silently omitted when `peerUrl` is absent.
 */
export async function runInterop({
  target,
  peerUrl,
  port = 8765,
  cases = ALL_CASES,
  publishTrigger,
  publishUrl,
  publishToken,
  event,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = (msg) => stdout.write(`${msg}\n`),
}) {
  const results = [];
  let server = null;
  let peer = null;

  const needsCallback = cases.some((c) => c !== "webfinger");
  if (needsCallback && !peerUrl) {
    for (const c of cases) {
      if (c === "webfinger") continue;
      results.push({
        case: c,
        status: "skipped",
        detail:
          "no --peer-url given; this case needs the target to deliver back to the peer",
      });
    }
    log(
      "No --peer-url given: only 'webfinger' can run (no callback needed). " +
        "The rest are reported skipped, not silently dropped.",
    );
  }

  if (cases.includes("webfinger") || peerUrl) {
    // `||`, not `??`: peerUrl arrives as the EMPTY STRING (not undefined)
    // when the workflow's env var is set but blank, and `new URL("")` throws.
    peer = await buildPeer(peerUrl || "http://localhost");
    if (peerUrl) {
      server = await serve(peer.federation, port, peerUrl);
      await waitForTunnelReady(peerUrl, log);
    }
  }

  try {
    for (const name of cases) {
      if (name === "webfinger") {
        // no-op: runs below regardless of peerUrl
      } else if (!peerUrl) {
        continue; // already recorded as skipped above
      }
      const fn = CASES[name];
      if (!fn) {
        results.push({
          case: name,
          status: "failing",
          detail: `unknown case '${name}' (expected one of ${ALL_CASES.join(", ")})`,
        });
        continue;
      }
      log(`--- ${name} ---`);
      try {
        const outcome = await fn({
          ctx: peer.ctx,
          target,
          received: peer.received,
          pages: peer.pages,
          publishTrigger,
          publishUrl,
          publishToken,
          event,
          timeoutMs,
          log,
        });
        results.push({
          case: name,
          status: outcome === "skipped" ? "skipped" : "passing",
        });
      } catch (error) {
        results.push({
          case: name,
          status: "failing",
          detail: error?.message ?? String(error),
        });
      }
    }
  } finally {
    if (server) {
      // Close pending keep-alive sockets too, so a peer that never sends
      // another request doesn't leave `server.close()` hanging.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  return { results };
}

async function main() {
  const rest = argv.slice(2);
  const flag = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i !== -1 ? rest[i + 1] : fallback;
  };

  const target = flag("target");
  if (!target) {
    stderr.write("Usage: fedify-peer.mjs --target <actor-url> [options]\n");
    exit(2);
    return;
  }
  const peerUrl = flag("peer-url", env.FEDIFY_PEER_URL);
  const port = Number(flag("port", "8765"));
  const timeoutMs = Number(flag("timeout", String(DEFAULT_TIMEOUT_MS)));
  const publishTrigger = flag("publish-trigger");
  // The announce-unwrap case drives the target's owner publish endpoint to
  // make it follow the peer's Group; the token is a secret, so it may come
  // from the environment instead of argv.
  const publishUrl = flag("publish-url", env.FEDIFY_PUBLISH_URL);
  const publishToken = flag("publish-token", env.FEDIFY_PUBLISH_TOKEN);
  const event = flag("event");
  const casesFlag = flag("case");
  const cases = casesFlag
    ? casesFlag.split(",").map((s) => s.trim())
    : ALL_CASES;

  const { results } = await runInterop({
    target,
    peerUrl,
    port,
    cases,
    publishTrigger,
    publishUrl,
    publishToken,
    event,
    timeoutMs,
  });

  stdout.write("\nResults:\n");
  let failed = false;
  for (const r of results) {
    stdout.write(
      `  ${r.status.padEnd(8)} ${r.case}${r.detail ? ` — ${r.detail}` : ""}\n`,
    );
    if (r.status === "failing") failed = true;
  }
  exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${argv[1]}`) {
  main().catch((error) => {
    stderr.write(`${error?.stack ?? error}\n`);
    exit(1);
  });
}
