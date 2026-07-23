/**
 * Typed post objects for `@dwk/activitypub` (fediverse interop phase 1, #274).
 *
 * The canonical owner-publish shape ({@link PostInput}) and the builders that
 * turn it into correctly-addressed ActivityStreams 2.0 `Note` / `Article` /
 * `Page` objects, plus the inbound classification helper that tags stored
 * activities with their object type and community audience. Content shaping is
 * what multi-platform interop actually needs — Pixelfed renders only posts
 * carrying media attachments, Lemmy expects titled `Page`s — so these builders
 * encode vocabulary (AS2 + the `toot:` extensions), never platform switches.
 *
 * Pure data: every function takes plain values and returns plain JSON, so this
 * module unit-tests without a Workers runtime.
 *
 * @see spec/fediverse-interop.md
 */

import {
  AS2_NS,
  PUBLIC_AUDIENCE,
  objectType,
  type ActivityObject,
  type ActorIris,
  type JsonValue,
} from "./as2.js";

/** Attachment media kinds a post may carry (AS2 `Document` subtypes). */
export const ATTACHMENT_TYPES = [
  "Image",
  "Video",
  "Audio",
  "Document",
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** Post kinds and the AS2 object type each maps to. */
export const POST_KINDS = {
  note: "Note",
  article: "Article",
  page: "Page",
} as const;
export type PostKind = keyof typeof POST_KINDS;

/** One media attachment on a post. */
export interface PostAttachment {
  readonly type: AttachmentType;
  /** Where the media bytes live (the AP package never hosts blobs itself). */
  readonly url: string;
  /** e.g. `image/jpeg`. */
  readonly mediaType?: string;
  /** Alt text (AS2 `name`). Always supply it for images. */
  readonly name?: string;
  /** Blurhash placeholder (`toot:blurhash`), passed through when supplied. */
  readonly blurhash?: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The canonical publish shape accepted by `POST <actor>/publish` (and, later,
 * the micropub adapter and the `activitypub_publish` MCP tool). One input, one
 * vocabulary — the builders decide the AS2 shape.
 */
export interface PostInput {
  readonly kind: PostKind;
  /** Sanitized HTML body. */
  readonly content: string;
  /** Title (AS2 `name`). REQUIRED when {@link kind} is `"page"`. */
  readonly name?: string;
  /** Content warning (AS2 `summary`). */
  readonly summary?: string;
  /** Marks attached media / content sensitive (`as:sensitive`). */
  readonly sensitive?: boolean;
  readonly attachments?: readonly PostAttachment[];
  /** IRI of the object this post replies to. */
  readonly inReplyTo?: string;
  /**
   * A `Group` actor IRI (community target, FEP-1b12). Emitted as `audience`
   * and added to `to`; delivery to the group's own inbox lands with phase 2
   * (#275) — until then the post still reaches followers and the public.
   */
  readonly audience?: string;
  /** Hashtags, with or without the leading `#`. */
  readonly tags?: readonly string[];
  /** Advanced addressing override; replaces the derived `to` entirely. */
  readonly to?: readonly string[];
  /** Advanced addressing override — mentions / secondary audiences (`cc`). */
  readonly cc?: readonly string[];
}

/**
 * The `@context` published posts carry: AS2 plus the `toot:` extension terms
 * (`sensitive` is an AS2 extension property, `blurhash` is Mastodon's) so
 * consumers that compact against the context resolve both.
 */
export const POST_CONTEXT: readonly JsonValue[] = [
  AS2_NS,
  {
    toot: "http://joinmastodon.org/ns#",
    sensitive: "as:sensitive",
    blurhash: "toot:blurhash",
  },
];

/** Result of {@link parsePostInput}: a validated input or a client-facing error. */
export type ParsedPostInput =
  | { readonly ok: true; readonly input: PostInput }
  | { readonly ok: false; readonly error: string };

const MAX_ATTACHMENTS = 16;
const MAX_TAGS = 32;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isAddressable(value: string): boolean {
  return value === PUBLIC_AUDIENCE || isHttpUrl(value);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | { error: string } {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    return { error: `\`${key}\` must be a non-empty string` };
  }
  return value;
}

function parseAttachment(
  value: unknown,
  index: number,
): PostAttachment | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `attachments[${index}] must be an object`;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (
    typeof type !== "string" ||
    !(ATTACHMENT_TYPES as readonly string[]).includes(type)
  ) {
    return `attachments[${index}].type must be one of ${ATTACHMENT_TYPES.join(", ")}`;
  }
  const url = record.url;
  if (typeof url !== "string" || !isHttpUrl(url)) {
    return `attachments[${index}].url must be an http(s) URL`;
  }
  const attachment: {
    type: AttachmentType;
    url: string;
    mediaType?: string;
    name?: string;
    blurhash?: string;
    width?: number;
    height?: number;
  } = { type: type as AttachmentType, url };
  for (const key of ["mediaType", "name", "blurhash"] as const) {
    const parsed = optionalString(record, key);
    if (parsed && typeof parsed === "object") {
      return `attachments[${index}].${key} must be a non-empty string`;
    }
    if (parsed !== undefined) attachment[key] = parsed;
  }
  for (const key of ["width", "height"] as const) {
    const dim = record[key];
    if (dim === undefined) continue;
    if (typeof dim !== "number" || !Number.isInteger(dim) || dim <= 0) {
      return `attachments[${index}].${key} must be a positive integer`;
    }
    attachment[key] = dim;
  }
  return attachment;
}

/**
 * Validate an untrusted publish body into a {@link PostInput}. Returns a
 * client-facing error message (never throws) so the endpoint can answer 400
 * with a precise reason.
 */
export function parsePostInput(value: unknown): ParsedPostInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "post must be a JSON object" };
  }
  const record = value as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== "string" || !(kind in POST_KINDS)) {
    return {
      ok: false,
      error: `\`kind\` must be one of ${Object.keys(POST_KINDS).join(", ")}`,
    };
  }
  const content = record.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "`content` must be a non-empty string" };
  }

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

  for (const key of ["name", "summary"] as const) {
    const parsed = optionalString(record, key);
    if (parsed && typeof parsed === "object") {
      return { ok: false, error: parsed.error };
    }
    if (parsed !== undefined) input[key] = parsed;
  }
  if (input.kind === "page" && input.name === undefined) {
    return {
      ok: false,
      error: '`name` (title) is required when `kind` is "page"',
    };
  }

  if (record.sensitive !== undefined) {
    if (typeof record.sensitive !== "boolean") {
      return { ok: false, error: "`sensitive` must be a boolean" };
    }
    input.sensitive = record.sensitive;
  }

  for (const key of ["inReplyTo", "audience"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isHttpUrl(value)) {
      return { ok: false, error: `\`${key}\` must be an http(s) IRI` };
    }
    input[key] = value;
  }

  if (record.attachments !== undefined) {
    if (!Array.isArray(record.attachments)) {
      return { ok: false, error: "`attachments` must be an array" };
    }
    if (record.attachments.length > MAX_ATTACHMENTS) {
      return {
        ok: false,
        error: `\`attachments\` must have at most ${MAX_ATTACHMENTS} entries`,
      };
    }
    const attachments: PostAttachment[] = [];
    for (const [index, entry] of record.attachments.entries()) {
      const parsed = parseAttachment(entry, index);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      attachments.push(parsed);
    }
    if (attachments.length > 0) input.attachments = attachments;
  }

  if (record.tags !== undefined) {
    if (
      !Array.isArray(record.tags) ||
      record.tags.some((t) => typeof t !== "string")
    ) {
      return { ok: false, error: "`tags` must be an array of strings" };
    }
    if (record.tags.length > MAX_TAGS) {
      return {
        ok: false,
        error: `\`tags\` must have at most ${MAX_TAGS} entries`,
      };
    }
    const tags = (record.tags as string[])
      .map((tag) => (tag.startsWith("#") ? tag.slice(1) : tag))
      .filter((tag) => tag.length > 0);
    if (tags.length > 0) input.tags = tags;
  }

  for (const key of ["to", "cc"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.some((v) => typeof v !== "string" || !isAddressable(v))
    ) {
      return {
        ok: false,
        error: `\`${key}\` must be an array of IRIs (or the Public collection)`,
      };
    }
    if (value.length > 0) input[key] = value as string[];
  }

  return { ok: true, input };
}

/** The `to`/`cc` a post derives when the input does not override them. */
export function postAddressing(
  input: PostInput,
  iris: ActorIris,
): { to: readonly string[]; cc: readonly string[] } {
  const to =
    input.to ??
    (input.audience ? [input.audience, PUBLIC_AUDIENCE] : [PUBLIC_AUDIENCE]);
  const cc = input.cc ?? [iris.followers];
  return { to, cc };
}

/** Identifiers the server mints for one published post. */
export interface PostIds {
  /** The `Create` activity IRI (server-assigned, under the outbox). */
  readonly activityId: string;
  /** The object IRI (server-assigned, under the activity). */
  readonly objectId: string;
  /** ISO-8601 publication timestamp. */
  readonly published: string;
}

/** Build the AS2 object (`Note`/`Article`/`Page`) for a validated post. */
export function buildPostObject(
  input: PostInput,
  iris: ActorIris,
  ids: PostIds,
): Record<string, JsonValue> {
  const { to, cc } = postAddressing(input, iris);
  const object: Record<string, JsonValue> = {
    id: ids.objectId,
    type: POST_KINDS[input.kind],
    attributedTo: iris.id,
    content: input.content,
    published: ids.published,
    to: to as JsonValue,
    cc: cc as JsonValue,
  };
  if (input.name !== undefined) object.name = input.name;
  if (input.summary !== undefined) object.summary = input.summary;
  if (input.sensitive !== undefined) object.sensitive = input.sensitive;
  if (input.inReplyTo !== undefined) object.inReplyTo = input.inReplyTo;
  if (input.audience !== undefined) object.audience = input.audience;
  if (input.attachments !== undefined) {
    object.attachment = input.attachments.map((attachment) => {
      const entry: Record<string, JsonValue> = {
        type: attachment.type,
        url: attachment.url,
      };
      if (attachment.mediaType !== undefined) {
        entry.mediaType = attachment.mediaType;
      }
      if (attachment.name !== undefined) entry.name = attachment.name;
      if (attachment.blurhash !== undefined) {
        entry.blurhash = attachment.blurhash;
      }
      if (attachment.width !== undefined) entry.width = attachment.width;
      if (attachment.height !== undefined) entry.height = attachment.height;
      return entry;
    });
  }
  if (input.tags !== undefined) {
    object.tag = input.tags.map((tag) => ({
      type: "Hashtag",
      name: `#${tag}`,
    }));
  }
  return object;
}

/**
 * Build the complete `Create` activity for a validated post — the shape the
 * publish endpoint stores in the outbox and fans out to followers.
 */
export function buildPostActivity(
  input: PostInput,
  iris: ActorIris,
  ids: PostIds,
): Record<string, JsonValue> {
  const { to, cc } = postAddressing(input, iris);
  const activity: Record<string, JsonValue> = {
    "@context": POST_CONTEXT as JsonValue,
    id: ids.activityId,
    type: "Create",
    actor: iris.id,
    published: ids.published,
    to: to as JsonValue,
    cc: cc as JsonValue,
    object: buildPostObject(input, iris, ids),
  };
  if (input.audience !== undefined) activity.audience = input.audience;
  return activity;
}

/**
 * Build a `Group`-authored `Announce` wrapping a member's activity (FEP-1b12
 * producer side, #376): a hosted community boosts everything a validated
 * member posts to its inbox, fanned out to the membership (`followers`) —
 * the "member-post → Announce" half of hosting a `Group` actor.
 */
export function buildAnnounceActivity(
  iris: ActorIris,
  id: string,
  published: string,
  inner: ActivityObject,
): Record<string, JsonValue> {
  return {
    "@context": AS2_NS,
    id,
    type: "Announce",
    actor: iris.id,
    published,
    to: [PUBLIC_AUDIENCE] as JsonValue,
    cc: [iris.followers] as JsonValue,
    object: inner as JsonValue,
  };
}

/** Classification of one stored inbound activity (nullable DO columns). */
export interface ActivityClassification {
  /** The embedded object's AS2 `type` (`Note`, `Page`, `Video`, …), if any. */
  readonly objectType?: string;
  /** The community (`Group`) audience the activity names, if any. */
  readonly audience?: string;
}

/**
 * The first IRI a value names, whether it is a string, an embedded object
 * (its `id` — AS2 lets `audience` carry a full `Group` object), or an array
 * of either.
 */
function firstIri(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const iri = firstIri(entry);
      if (iri !== undefined) return iri;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const id = (value as Record<string, JsonValue>).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * Classify an inbound activity for storage: the wrapped object's type and the
 * `audience` it names (on the activity, or on the embedded object). Pure
 * annotation — unknown shapes yield an empty classification, never an error,
 * preserving the inbox's liberal store-and-ignore behavior.
 */
export function classifyActivity(
  activity: ActivityObject,
): ActivityClassification {
  const classification: { objectType?: string; audience?: string } = {};
  const type = objectType(activity.object);
  if (type !== undefined) classification.objectType = type;

  let audience = firstIri(activity.audience);
  if (audience === undefined) {
    const inner = activity.object;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      audience = firstIri((inner as Record<string, JsonValue>).audience);
    }
  }
  if (audience !== undefined && audience !== PUBLIC_AUDIENCE) {
    classification.audience = audience;
  }
  return classification;
}
