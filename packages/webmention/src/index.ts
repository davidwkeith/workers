/**
 * `@dwk/webmention` — Webmention (W3C) receiver + sender.
 *
 * Endpoint package. The receiver validates `source`/`target` synchronously,
 * returns `202 Accepted`, and enqueues the pair for asynchronous link
 * verification; the queue consumer fetches the source, confirms it links to the
 * target, and persists (or removes) the mention in an inbox. The sender
 * discovers a target's Webmention endpoint and notifies it on publish. Cloud
 * specifics (Queue, D1) are confined here; HTML scanning uses the runtime's
 * streaming `HTMLRewriter`, so the parsing/verification helpers are async and
 * exercised under the Workers test pool. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import type {
  D1Database,
  ExecutionContext,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import {
  hostFromUrl,
  noopLogger,
  noopMetrics,
  type Logger,
  type Metrics,
} from "@dwk/log";
import { createD1Inbox, type InboxStore } from "./inbox";
import type { FetchLike } from "./fetch";
import { WebmentionLogEvent } from "./log";
import { validateWebmentionParams } from "./validate";
import { verifySource } from "./verify";

export {
  validateWebmentionParams,
  type ValidateParams,
  type ValidationResult,
  type WebmentionValidationError,
} from "./validate";
export {
  discoverEndpoint,
  findWebmentionEndpoint,
  type DiscoverOptions,
} from "./discovery";
export {
  sendWebmention,
  sendWebmentions,
  type SendOptions,
  type SendResult,
} from "./sender";
export {
  verifySource,
  sourceLinksTo,
  extractLinks,
  type VerifyOptions,
  type VerifyResult,
} from "./verify";
export {
  createD1Inbox,
  type InboxStore,
  type VerifiedMention,
  type D1InboxOptions,
} from "./inbox";
export type { FetchLike } from "./fetch";
export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "./safe-fetch";
export { WebmentionLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";

/** A queued verification job: confirm that `source` links to `target`. */
export interface WebmentionJob {
  readonly source: string;
  readonly target: string;
}

/** Cloudflare bindings required by the Webmention handler and queue consumer. */
export interface WebmentionEnv {
  /** Queue producer for async verification of received mentions. */
  readonly WEBMENTION_QUEUE: Queue<WebmentionJob>;
  /**
   * D1 database backing the default inbox. Optional only when an
   * {@link InboxStore} is supplied via {@link WebmentionConfig.inbox} (e.g. a
   * Solid Pod DO-backed inbox).
   */
  readonly WEBMENTION_INBOX?: D1Database;
}

/** Configuration passed to {@link createWebmention}. */
export interface WebmentionConfig {
  /** Base URL of this receiver; a `target` must live under its origin. */
  readonly baseUrl: string;
  /** Additional controlled hostnames besides `baseUrl`'s. */
  readonly allowedHosts?: readonly string[];
  /**
   * Inbox store for verified mentions. Defaults to a D1 store built from
   * {@link WebmentionEnv.WEBMENTION_INBOX}; supply one to back the inbox with
   * the `@dwk/solid-pod` Durable Object instead.
   */
  readonly inbox?: InboxStore;
  /** `fetch` implementation for verification; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /**
   * Logger for receiver/queue events; defaults to a no-op. Wire a real logger
   * (see `@dwk/log`) to surface SSRF blocks, validation rejections, and
   * poison-message retries instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for receiver/queue counters; defaults to a no-op. Wire an
   * adapter (e.g. `analyticsEngineMetrics` from `@dwk/log`, bound to an
   * `AnalyticsEngineDataset`) to chart the same events the logger names —
   * "SSRF blocks/min", "verification success rate", "queue retries by reason".
   */
  readonly metrics?: Metrics;
}

/** A `fetch`-compatible Worker handler. */
export type WebmentionHandler = (
  request: Request,
  env: WebmentionEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** A Queue consumer for asynchronous Webmention verification. */
export type WebmentionQueueConsumer = (
  batch: MessageBatch<WebmentionJob>,
  env: WebmentionEnv,
  ctx: ExecutionContext,
) => Promise<void>;

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function resolveInbox(
  config: WebmentionConfig,
  env: WebmentionEnv,
): InboxStore {
  if (config.inbox !== undefined) {
    return config.inbox;
  }
  if (env.WEBMENTION_INBOX !== undefined) {
    return createD1Inbox(env.WEBMENTION_INBOX);
  }
  throw new Error(
    "@dwk/webmention: no inbox configured — provide config.inbox or bind " +
      "WEBMENTION_INBOX (D1).",
  );
}

function formValue(value: string | File | null): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Build the Webmention receiver handler from configuration.
 *
 * The returned handler is mountable under any path prefix. It accepts a
 * form-encoded `POST` (`source` + `target`), validates synchronously, enqueues
 * the pair for verification, and returns `202 Accepted`. Invalid requests get
 * `400`; other methods get `405`. Fails loudly if the required `WEBMENTION_QUEUE`
 * binding is missing.
 */
export function createWebmention(config: WebmentionConfig): WebmentionHandler {
  const logger = config.logger ?? noopLogger;
  const metrics = config.metrics ?? noopMetrics;
  return async (request, env, _ctx) => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    if (env.WEBMENTION_QUEUE === undefined) {
      throw new Error(
        "@dwk/webmention: missing required binding WEBMENTION_QUEUE.",
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return textResponse(
        400,
        "invalid_request: expected a form-encoded body with source and target",
      );
    }

    const result = validateWebmentionParams({
      source: formValue(form.get("source")),
      target: formValue(form.get("target")),
      baseUrl: config.baseUrl,
      allowedHosts: config.allowedHosts,
    });
    if (!result.ok) {
      const fields = { reason: result.error };
      logger.warn(WebmentionLogEvent.ReceiveRejected, fields);
      metrics.count(WebmentionLogEvent.ReceiveRejected, fields);
      return textResponse(400, result.error);
    }

    await env.WEBMENTION_QUEUE.send({
      source: result.source,
      target: result.target,
    });

    const fields = {
      sourceHost: hostFromUrl(result.source),
      targetHost: hostFromUrl(result.target),
    };
    logger.info(WebmentionLogEvent.ReceiveAccepted, fields);
    metrics.count(WebmentionLogEvent.ReceiveAccepted, fields);
    return new Response(null, { status: 202 });
  };
}

/**
 * Build the Queue consumer that verifies received mentions.
 *
 * For each job it fetches the source and checks for a link to the target: a
 * verified mention is upserted into the inbox, while a source that no longer
 * links is removed. A job that throws is retried; otherwise it is acked. Fails
 * loudly if no inbox is configured.
 */
export function createWebmentionQueueConsumer(
  config: WebmentionConfig,
): WebmentionQueueConsumer {
  const logger = config.logger ?? noopLogger;
  const metrics = config.metrics ?? noopMetrics;
  return async (batch, env, _ctx) => {
    const inbox = resolveInbox(config, env);
    for (const message of batch.messages) {
      const { source, target } = message.body;
      try {
        const result = await verifySource(source, target, {
          fetch: config.fetch,
          logger,
          metrics,
        });
        if (result.links) {
          await inbox.store({ source, target, verifiedAt: Date.now() });
        } else {
          await inbox.remove(source, target);
        }
        message.ack();
      } catch (err) {
        // A poison message must not retry silently — record why so an operator
        // can tell a transient failure from a wedged one.
        const fields = {
          sourceHost: hostFromUrl(source),
          targetHost: hostFromUrl(target),
          error: err instanceof Error ? err.name : "unknown",
        };
        logger.warn(WebmentionLogEvent.QueueRetry, fields);
        metrics.count(WebmentionLogEvent.QueueRetry, fields);
        message.retry();
      }
    }
  };
}
