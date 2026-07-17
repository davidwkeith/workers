/**
 * `@dwk/mcp` tool contribution: `micropub_publish`. Closes over the existing
 * publish path (`publishPost` in `handler.ts`) so the MCP tool and the HTTP
 * `create` action share identical slug-generation, collision-retry, and
 * persistence behavior — the same adapter rule as `@dwk/calendar`'s per-standard
 * event mappers (the tool definition lives here, never in `@dwk/mcp`).
 *
 * @see spec/packages/mcp.md
 */

import type { ToolCallResult, ToolDefinition } from "@dwk/mcp";

import { absoluteUrl, publishPost } from "./handler.js";
import type { ResolvedConfig } from "./config.js";
import type { Mf2Object, MicropubCommands } from "./mf2.js";
import type { MicropubStore } from "./store.js";

/** Configuration for {@link createMicropubMcpTools}. */
export interface MicropubMcpToolsConfig {
  /**
   * The resolved Micropub config (see `resolveConfig`) — reused so URL
   * generation and the site's post-URL policy match the HTTP endpoint exactly.
   */
  readonly config: ResolvedConfig;
  /** The post store, e.g. `createMicropubStore(env)`. */
  readonly store: MicropubStore;
  /**
   * The scope a caller's token must carry to call `micropub_publish`. Defaults
   * to `"create"`, matching the scope the HTTP endpoint requires for the same
   * action.
   */
  readonly requiredScope?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPropertyMap(value: unknown): value is Record<string, unknown[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => Array.isArray(v));
}

function toolError(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build the `micropub_publish` tool: publish a new mf2 post through the same
 * {@link publishPost} path the HTTP `create` action uses. Side-effecting
 * (`readOnlyHint: false`) — supports a `dryRun` preview that reports the URL a
 * real publish would allocate without persisting anything, so an agent (or its
 * operator) can confirm before committing to a publish.
 */
export function createMicropubMcpTools(
  options: MicropubMcpToolsConfig,
): ToolDefinition[] {
  const { config, store, requiredScope = "create" } = options;

  return [
    {
      name: "micropub_publish",
      description:
        "Publish a new post to this site via Micropub (create an h-entry, " +
        "h-event, or other microformats2 post type). Set `dryRun: true` to " +
        "preview the URL that would be allocated without persisting the post.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "array",
            items: { type: "string" },
            description:
              'Microformats2 vocabulary types, e.g. ["h-entry"]. Defaults to ["h-entry"].',
          },
          properties: {
            type: "object",
            description:
              'mf2 property name to an array of values, e.g. {"content": ["Hello world"], "category": ["indieweb"]}.',
          },
          slug: {
            type: "string",
            description: "Preferred URL slug (`mp-slug`).",
          },
          dryRun: {
            type: "boolean",
            description:
              "If true, compute and return the URL a publish would use without persisting anything. Defaults to false.",
          },
        },
        required: ["properties"],
        additionalProperties: false,
      },
      annotations: {
        title: "Publish a post",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      requiredScope,
      handler: async (args) => {
        const rawType = args.type;
        if (rawType !== undefined && !isStringArray(rawType)) {
          return toolError("`type` must be an array of strings.");
        }
        const rawProperties = args.properties;
        if (!isPropertyMap(rawProperties)) {
          return toolError("`properties` must be an object of arrays.");
        }
        const rawSlug = args.slug;
        if (rawSlug !== undefined && typeof rawSlug !== "string") {
          return toolError("`slug` must be a string.");
        }

        const mf2: Mf2Object = {
          type: rawType ?? ["h-entry"],
          properties: rawProperties,
        };
        const commands: MicropubCommands = {
          ...(rawSlug !== undefined ? { slug: rawSlug } : {}),
          syndicateTo: [],
        };

        if (args.dryRun === true) {
          const url = absoluteUrl(
            await config.generatePostUrl(mf2, commands),
            config.micropubEndpoint,
          );
          return {
            content: [
              { type: "text", text: JSON.stringify({ dryRun: true, url }) },
            ],
            structuredContent: { dryRun: true, url },
          };
        }

        const result = await publishPost(mf2, commands, config, store);
        if (!result.ok) {
          return toolError(result.description);
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ url: result.url }) },
          ],
          structuredContent: { url: result.url },
        };
      },
    },
  ];
}
