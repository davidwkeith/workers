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
  /**
   * The actor's raw AS2 outbox (`<actor>/outbox`), where a deleted entry's
   * copies are retracted with a `Delete`. Defaults to {@link publishUrl}
   * with its trailing `/publish` replaced by `/outbox`.
   */
  readonly outboxUrl?: string;
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
  /** The entry's permalink, which the fediverse copy links back to (AS2 `url`). */
  readonly url?: string;
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
  options: { readonly audience?: string; readonly url?: string } = {},
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
    ...(options.url !== undefined ? { url: options.url } : {}),
  };
}

/** One syndication attempt's outcome, for logging/return metadata. */
export interface SyndicationResult {
  readonly target: string;
  readonly ok: boolean;
  /** The created activity IRI (the publish endpoint's Location), on success. */
  readonly location?: string;
  /**
   * The created object's IRI (the response body's `object.id`), on success:
   * the fediverse copy, recorded as the entry's `syndication`.
   */
  readonly object?: string;
  readonly error?: string;
}

/** The `object.id` of the `Create` a publish answered with, if it has one. */
async function createdObjectId(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { object?: unknown };
    const object = body.object;
    const id =
      typeof object === "string"
        ? object
        : object && typeof object === "object"
          ? (object as { id?: unknown }).id
          : undefined;
    if (typeof id !== "string") return undefined;
    const protocol = new URL(id).protocol;
    return protocol === "https:" || protocol === "http:" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Deliver one mapped post to the ActivityPub publish endpoint. */
export async function deliverFediversePost(
  config: FediverseSyndicationConfig,
  target: string,
  post: FediversePost,
): Promise<SyndicationResult> {
  const fetchImpl = config.fetch ?? fetch;
  // The whole exchange — including reading the failure body — sits inside
  // one try/catch: syndication is non-fatal by contract, so no network or
  // body-read error may ever escape to the caller.
  try {
    const response = await fetchImpl(config.publishUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.publishToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(post),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let reason: string;
      try {
        reason = await response.text();
      } catch {
        reason = "(failed to read response body)";
      }
      return {
        target,
        ok: false,
        error: `publish endpoint answered ${response.status}: ${reason}`,
      };
    }
    const location = response.headers.get("location");
    const object = await createdObjectId(response);
    return {
      target,
      ok: true,
      ...(location ? { location } : {}),
      ...(object ? { object } : {}),
    };
  } catch (err) {
    return { target, ok: false, error: String(err) };
  }
}

/**
 * Syndicate a created entry to every requested fediverse target: the
 * reserved {@link FEDIVERSE_TARGET_UID} posts to the actor's followers; any
 * other requested uid that appears in the advertised target list is treated
 * as a community (`Group` IRI) target. Unknown uids are ignored (they may
 * belong to a different syndication network). Failures are reported per
 * target and logged — a failed syndication never fails the post creation.
 * `url`, the entry's permalink, becomes each copy's link back to it.
 */
export async function syndicateEntry(
  config: FediverseSyndicationConfig,
  mf2: Mf2Object,
  requested: readonly string[],
  advertised: readonly { readonly uid: string }[],
  logger?: Logger,
  url?: string,
): Promise<SyndicationResult[]> {
  const advertisedUids = new Set(advertised.map((t) => t.uid));
  // Deliveries run in parallel (each is independently bounded and non-fatal)
  // so one slow community endpoint never serializes behind the others and
  // delays the client's create response. `Promise.all` preserves request
  // order in the results.
  const outcomes = await Promise.all(
    requested.map(async (uid): Promise<SyndicationResult | null> => {
      const isFollowersTarget = uid === FEDIVERSE_TARGET_UID;
      if (!isFollowersTarget && !advertisedUids.has(uid)) return null;
      const post = entryToFediversePost(mf2, {
        ...(isFollowersTarget ? {} : { audience: uid }),
        ...(url !== undefined ? { url } : {}),
      });
      if (typeof post === "string") {
        logger?.warn("micropub.syndicate.rejected", {
          target: uid,
          reason: post,
        });
        return { target: uid, ok: false, error: post };
      }
      const result = await deliverFediversePost(config, uid, post);
      if (!result.ok) {
        logger?.warn("micropub.syndicate.failed", {
          target: uid,
          reason: result.error,
        });
      }
      return result;
    }),
  );
  return outcomes.filter((r): r is SyndicationResult => r !== null);
}

/** The actor's outbox: the configured one, or the one beside `/publish`. */
function outboxUrlOf(config: FediverseSyndicationConfig): string {
  return config.outboxUrl ?? config.publishUrl.replace(/\/publish$/, "/outbox");
}

/** One retraction attempt's outcome, for logging. */
export interface RetractionResult {
  readonly object: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Retract a deleted entry's fediverse copies: POST an AS2 `Delete` to the
 * actor's outbox for each `syndication` URL that is one of the actor's own
 * outbox objects (other sites' copies are left to them). Addressed like the
 * copies (the public and the followers), so followers' servers drop them.
 * Non-fatal like syndication: failures are reported and logged.
 */
export async function retractFediverseCopies(
  config: FediverseSyndicationConfig,
  syndication: readonly unknown[],
  logger?: Logger,
): Promise<RetractionResult[]> {
  const outbox = outboxUrlOf(config);
  const actor = outbox.replace(/\/outbox$/, "");
  const copies = syndication.filter(
    (s): s is string => typeof s === "string" && s.startsWith(`${outbox}/`),
  );
  const fetchImpl = config.fetch ?? fetch;
  return Promise.all(
    copies.map(async (object): Promise<RetractionResult> => {
      try {
        const response = await fetchImpl(outbox, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.publishToken}`,
            "content-type": "application/activity+json",
          },
          body: JSON.stringify({
            "@context": "https://www.w3.org/ns/activitystreams",
            type: "Delete",
            object,
            to: ["https://www.w3.org/ns/activitystreams#Public"],
            cc: [`${actor}/followers`],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return { object, ok: true };
        const result = {
          object,
          ok: false,
          error: `outbox answered ${response.status}`,
        };
        logger?.warn("micropub.syndicate.retract_failed", {
          reason: result.error,
        });
        return result;
      } catch (err) {
        logger?.warn("micropub.syndicate.retract_failed", {
          reason: String(err),
        });
        return { object, ok: false, error: String(err) };
      }
    }),
  );
}
