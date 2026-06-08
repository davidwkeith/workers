/**
 * Make Node's `Request` accept a streaming body without an explicit `duplex`,
 * matching the workerd `Request`.
 *
 * The packages forward requests to their Durable Object by constructing
 * `new Request(url, { method, headers, body: request.body })` — where
 * `request.body` is a `ReadableStream`. workerd allows this; Node/undici throws
 * `RequestInit: duplex option is required when sending a body`. Since the
 * packages must run unchanged, the host patches the global `Request` constructor
 * to default `duplex: "half"` when a body is supplied and none was given. This
 * is the only valid value today, so it cannot change observable behaviour;
 * it just removes a Node-only papercut. Idempotent.
 *
 * @see spec/self-hosting.md §6, §7.4
 */

const PATCHED = Symbol.for("dwk.server.requestDuplexPatched");

/** Patch the global `Request` to default `duplex: "half"` for body requests. */
export function installRequestDuplex(): void {
  const Original = globalThis.Request;
  if ((Original as unknown as Record<symbol, unknown>)[PATCHED]) return;

  class DuplexRequest extends Original {
    constructor(...args: never[]) {
      const init = args[1] as { body?: unknown; duplex?: unknown } | undefined;
      if (init != null && init.body != null && init.duplex === undefined) {
        super(
          args[0] as never,
          { ...(init as object), duplex: "half" } as never,
        );
      } else {
        super(args[0] as never, args[1] as never);
      }
    }
  }
  (DuplexRequest as unknown as Record<symbol, unknown>)[PATCHED] = true;
  globalThis.Request = DuplexRequest as unknown as typeof globalThis.Request;
}
