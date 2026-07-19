/**
 * Community syndication targets (§2.4 / #278): expose this actor's accepted
 * `Group` follows in the `{uid, name}` shape `@dwk/micropub` advertises via
 * `q=syndicate-to`, so a Micropub client can cross-post into a followed
 * community. The `uid` is the Group's stable actor IRI; the `name` is a
 * display handle derived from it (`!birding@lemmy.ml`).
 *
 * `@dwk/micropub` stays free of ActivityPub imports — it accepts any async
 * provider of this plain shape; this module is the ActivityPub-aware side of
 * that seam.
 *
 * @see spec/fediverse-interop.md (Capability 3)
 */

import { INTERNAL_HEADERS, type ResolvedConfig } from "./config.js";
import { communityDisplayHandle } from "./discovery.js";
import { forwardedConfig } from "./handler.js";
import type { ActivityPubObject } from "./object.js";

/** The plain target shape micropub advertises (mirrors its `SyndicationTarget`). */
export interface CommunityTarget {
  /** The community's `Group` actor IRI — the stable identifier clients echo back. */
  readonly uid: string;
  /** Display handle, e.g. `!birding@lemmy.ml`. */
  readonly name: string;
}

/** Options for {@link createCommunitySyndicationTargets}. */
export interface CommunityTargetsOptions {
  /** The actor's resolved config — shared with `createActivityPub`. */
  readonly config: ResolvedConfig;
  /** The per-actor Durable Object namespace, e.g. `env.ACTOR`. */
  readonly actor: DurableObjectNamespace<ActivityPubObject>;
}

/**
 * Build an async provider of the actor's followed communities, suitable for
 * `@dwk/micropub`'s `syndicateTo` config. Reads the internal `__following`
 * route (accepted follows typed `Group`); failures yield an empty list so a
 * transient DO error never breaks the Micropub config query.
 */
export function createCommunitySyndicationTargets(
  options: CommunityTargetsOptions,
): () => Promise<CommunityTarget[]> {
  const { config, actor } = options;
  return async () => {
    const url = new URL(`${config.iris.id}/__following`);
    url.searchParams.set("type", "Group");
    const headers = new Headers();
    headers.set(
      INTERNAL_HEADERS.config,
      JSON.stringify(forwardedConfig(config)),
    );
    try {
      const id = actor.idFromName(config.iris.id);
      const response = await actor
        .get(id)
        .fetch(new Request(url.toString(), { headers }));
      if (!response.ok) return [];
      const listing = (await response.json()) as {
        items?: { actor?: unknown }[];
      };
      if (!Array.isArray(listing.items)) return [];
      return listing.items
        .map((item) => item.actor)
        .filter((iri): iri is string => typeof iri === "string")
        .map((iri) => ({ uid: iri, name: communityDisplayHandle(iri) }));
    } catch {
      return [];
    }
  };
}
