/**
 * `@dwk/websub` — the hub `fetch` handler and publish-notifier factory.
 *
 * `createWebSub` builds the WebSub hub endpoint: a single `POST`-only handler,
 * mountable under any path prefix, that fields subscribe/unsubscribe requests and
 * publish pings. Slow work (intent verification, content fan-out) is validated
 * synchronously and pushed onto the queue, so the handler returns `202 Accepted`
 * fast and the queue consumer (see {@link createWebSubQueueConsumer}) does the
 * I/O with retries. `createPublishNotifier` is the in-process equivalent of a
 * publish ping, for the Micropub write / Anglesite rebuild path. See
 * `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import { hostFromUrl, type LogFields } from "@dwk/log";
import type { ExecutionContext } from "@cloudflare/workers-types";
import {
  resolveConfig,
  type ResolvedConfig,
  type WebSubConfig,
  type WebSubEnv,
} from "./config";
import { WebSubLogEvent } from "./log";
import { readHubParams, validatePublish, validateSubscribe } from "./validate";

/** A `fetch`-compatible Worker handler. */
export type WebSubHandler = (
  request: Request,
  env: WebSubEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * An in-process publish notifier: call it from the Micropub write path or an
 * Anglesite rebuild hook to enqueue distribution of `topic` to its subscribers.
 */
export type PublishNotifier = (env: WebSubEnv, topic: string) => Promise<void>;

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function requireQueue(env: WebSubEnv): void {
  if (env.WEBSUB_QUEUE === undefined) {
    throw new Error("@dwk/websub: missing required binding WEBSUB_QUEUE.");
  }
}

function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/**
 * Build the WebSub hub handler from configuration.
 *
 * Accepts a form-encoded `POST`. `hub.mode=subscribe|unsubscribe` is validated
 * and the verification-of-intent job enqueued (`202`); `hub.mode=publish`
 * enqueues a distribution job (`202`). Invalid requests get `400` with a stable
 * error code; other methods get `405`. Fails loudly if `WEBSUB_QUEUE` is missing.
 */
export function createWebSub(config: WebSubConfig): WebSubHandler {
  const resolved = resolveConfig(config);
  return async (request, env, _ctx) => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    requireQueue(env);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return textResponse(400, "invalid_request");
    }

    // Lift the form into a string-only URLSearchParams; a `File`-valued field
    // (multipart upload) is not a valid `hub.*` parameter and is dropped.
    const search = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        search.append(key, value);
      }
    }
    const params = readHubParams(search);

    if (params.mode === "publish") {
      const result = validatePublish(params, resolved);
      if (!result.ok) {
        emit(resolved, "warn", WebSubLogEvent.PublishRejected, {
          reason: result.error,
        });
        return textResponse(400, result.error);
      }
      await env.WEBSUB_QUEUE.send({ kind: "distribute", topic: result.topic });
      emit(resolved, "info", WebSubLogEvent.PublishAccepted, {
        topicHost: hostFromUrl(result.topic),
      });
      return new Response(null, { status: 202 });
    }

    const result = validateSubscribe(params, resolved);
    if (!result.ok) {
      emit(resolved, "warn", WebSubLogEvent.RequestRejected, {
        reason: result.error,
      });
      return textResponse(400, result.error);
    }

    await env.WEBSUB_QUEUE.send({
      kind: "verify",
      mode: result.mode,
      callback: result.callback,
      topic: result.topic,
      leaseSeconds: result.leaseSeconds,
      ...(result.secret !== undefined ? { secret: result.secret } : {}),
    });
    emit(resolved, "info", WebSubLogEvent.RequestAccepted, {
      mode: result.mode,
      callbackHost: hostFromUrl(result.callback),
      topicHost: hostFromUrl(result.topic),
    });
    return new Response(null, { status: 202 });
  };
}

/**
 * Build an in-process publish notifier. The returned function enqueues a
 * distribution job for `topic` (after checking it is a topic this hub serves),
 * so a Micropub write or static rebuild can fan out a push without going through
 * the HTTP publish endpoint.
 *
 * @throws when `topic` is not one this hub serves — a caller wiring this into its
 * own write path should only ever publish its own feeds.
 */
export function createPublishNotifier(config: WebSubConfig): PublishNotifier {
  const resolved = resolveConfig(config);
  return async (env, topic) => {
    requireQueue(env);
    if (!resolved.isAllowedTopic(topic)) {
      throw new Error(
        `@dwk/websub: refusing to publish unsupported topic ${hostFromUrl(topic) ?? "<invalid>"}.`,
      );
    }
    await env.WEBSUB_QUEUE.send({ kind: "distribute", topic });
    emit(resolved, "info", WebSubLogEvent.PublishAccepted, {
      topicHost: hostFromUrl(topic),
    });
  };
}
