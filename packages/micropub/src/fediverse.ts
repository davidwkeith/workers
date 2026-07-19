/**
 * Fediverse syndication adapter (fediverse interop phase 3, #278): map an
 * `h-entry` onto the plain `PostInput` JSON that `@dwk/activitypub`'s
 * owner-gated `POST <actor>/publish` endpoint accepts, and deliver it there
 * when the client asked to syndicate (`mp-syndicate-to`).
 *
 * The adapter lives HERE, in the Micropub endpoint package, per the
 * cross-standard-lib rule — and it deliberately does NOT import
 * `@dwk/activitypub`: the publish endpoint's JSON body is the wire contract,
 * so the two packages stay composable without a code dependency. A target
 * whose `uid` is a community's `Group` actor IRI becomes a titled `page`
 * addressed to that community (`audience`); the reserved
 * {@link FEDIVERSE_TARGET_UID} uid posts a plain note/article to the actor's
 * own followers.
 *
 * @see spec/fediverse-interop.md (Capability 3)
 */

import type { Logger } from "@dwk/log";

import type { Mf2Object } from "./mf2.js";

/**
 * The reserved `mp-syndicate-to` uid for "the actor's own followers" (no
 * community target). Compose it into `syndicateTo` as
 * `{ uid: FEDIVERSE_TARGET_UID, name: "@you@your.domain" }`.
 */
export const FEDIVERSE_TARGET_UID = "fediverse";

/** Config for delivering syndicated posts to the ActivityPub publish endpoint. */
export interface FediverseSyndicationConfig {
  /** The shaped-publish endpoint URL, i.e. `<actor>/publish`. */
  readonly publishUrl: string;
  /** The `@dwk/activitypub` `publishToken` authorizing owner publishes. */
  readonly publishToken: string;
  /** Transport override (tests); defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * The publish endpoint's wire shape (mirrors `@dwk/activitypub`'s
 * `PostInput`; duplicated here by design — the JSON is the contract).
 */
export interface FediversePost {
  readonly kind: "note" | "article" | "page";
  readonly content: string;
  readonly name?: string;
  readonly summary?: string;
  readonly sensitive?: boolean;
  readonly attachments?: readonly {
    readonly type: "Image" | "Video" | "Audio";
    readonly url: string;
    readonly name?: string;
  }[];
  readonly audience?: string;
  readonly tags?: readonly string[];
}

/** First value of an mf2 property, when it is a plain string. */
function firstString(
  properties: Mf2Object["properties"],
  key: string,
): string | undefined {
  const value = properties[key]?.[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The post body: `content` may be a string or an `{html, value}` object. */
function contentOf(properties: Mf2Object["properties"]): string | undefined {
  const value = properties.content?.[0];
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.html === "string" && record.html.length > 0) {
      return record.html;
    }
    if (typeof record.value === "string" && record.value.length > 0) {
      return record.value;
    }
  }
  return undefined;
}

/** Media attachments from `photo`/`video`/`audio` (string URL or `{value, alt}`). */
function attachmentsOf(
  properties: Mf2Object["properties"],
): FediversePost["attachments"] {
  const attachments: {
    type: "Image" | "Video" | "Audio";
    url: string;
    name?: string;
  }[] = [];
  const kinds = [
    ["photo", "Image"],
    ["video", "Video"],
    ["audio", "Audio"],
  ] as const;
  for (const [property, type] of kinds) {
    for (const value of properties[property] ?? []) {
      if (typeof value === "string" && value.length > 0) {
        attachments.push({ type, url: value });
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record.value === "string" && record.value.length > 0) {
          attachments.push({
            type,
            url: record.value,
            ...(typeof record.alt === "string" && record.alt.length > 0
              ? { name: record.alt }
              : {}),
          });
        }
      }
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Map an `h-entry` onto a fediverse post. `audience` set ⇒ a community
 * `page` (title required — falls back to nothing and errors); otherwise
 * `name` + `content` ⇒ `article`, plain `content` ⇒ `note` (with `photo`
 * attachments making it a Pixelfed-renderable media note). Returns a
 * client-facing error string when the entry cannot be mapped.
 */
export function entryToFediversePost(
  mf2: Mf2Object,
  options: { readonly audience?: string } = {},
): FediversePost | string {
  if (!mf2.type.includes("h-entry")) {
    return "only h-entry posts syndicate to the fediverse";
  }
  const properties = mf2.properties;
  const content = contentOf(properties);
  if (content === undefined) {
    return "an entry needs `content` to syndicate to the fediverse";
  }
  const name = firstString(properties, "name");
  const summary = firstString(properties, "summary");
  const tags = (properties.category ?? []).filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  const attachments = attachmentsOf(properties);

  let kind: FediversePost["kind"];
  if (options.audience !== undefined) {
    if (name === undefined) {
      return "a community post needs `name` (its title)";
    }
    kind = "page";
  } else {
    kind = name !== undefined ? "article" : "note";
  }

  return {
    kind,
    content,
    ...(name !== undefined ? { name } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** One syndication attempt's outcome, for logging/return metadata. */
export interface SyndicationResult {
  readonly target: string;
  readonly ok: boolean;
  /** The created activity IRI (the publish endpoint's Location), on success. */
  readonly location?: string;
  readonly error?: string;
}

/** Deliver one mapped post to the ActivityPub publish endpoint. */
export async function deliverFediversePost(
  config: FediverseSyndicationConfig,
  target: string,
  post: FediversePost,
): Promise<SyndicationResult> {
  const fetchImpl = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(config.publishUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.publishToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(post),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { target, ok: false, error: String(err) };
  }
  if (!response.ok) {
    return {
      target,
      ok: false,
      error: `publish endpoint answered ${response.status}: ${await response.text()}`,
    };
  }
  return {
    target,
    ok: true,
    ...(response.headers.get("location")
      ? { location: response.headers.get("location") as string }
      : {}),
  };
}

/**
 * Syndicate a created entry to every requested fediverse target: the
 * reserved {@link FEDIVERSE_TARGET_UID} posts to the actor's followers; any
 * other requested uid that appears in the advertised target list is treated
 * as a community (`Group` IRI) target. Unknown uids are ignored (they may
 * belong to a different syndication network). Failures are reported per
 * target and logged — a failed syndication never fails the post creation.
 */
export async function syndicateEntry(
  config: FediverseSyndicationConfig,
  mf2: Mf2Object,
  requested: readonly string[],
  advertised: readonly { readonly uid: string }[],
  logger?: Logger,
): Promise<SyndicationResult[]> {
  const advertisedUids = new Set(advertised.map((t) => t.uid));
  const results: SyndicationResult[] = [];
  for (const uid of requested) {
    const isFollowersTarget = uid === FEDIVERSE_TARGET_UID;
    if (!isFollowersTarget && !advertisedUids.has(uid)) continue;
    const post = entryToFediversePost(mf2, {
      ...(isFollowersTarget ? {} : { audience: uid }),
    });
    if (typeof post === "string") {
      results.push({ target: uid, ok: false, error: post });
      logger?.warn("micropub.syndicate.rejected", {
        target: uid,
        reason: post,
      });
      continue;
    }
    const result = await deliverFediversePost(config, uid, post);
    results.push(result);
    if (!result.ok) {
      logger?.warn("micropub.syndicate.failed", {
        target: uid,
        reason: result.error,
      });
    }
  }
  return results;
}
