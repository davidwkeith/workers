/**
 * The workerd WebSocket-hibernation primitives, emulated in-process.
 *
 * A Durable Object accepts a notification subscription by minting a
 * `new WebSocketPair()`, handing one end to `ctx.acceptWebSocket()` and
 * returning the other on `new Response(null, { status: 101, webSocket: client })`.
 * It later pushes events with `server.send()`. Node provides neither
 * `WebSocketPair` nor a `Response` that carries a socket (its `Response` even
 * rejects status `101`), so the host installs both as globals:
 *
 * - **`WebSocketPair`** — two linked in-memory sockets; `a.send(x)` dispatches a
 *   `message` event on `b` and vice-versa, so the DO's `server.send()` reaches
 *   the end the host bridges to the network (see {@link ./web-socket-upgrade}).
 * - **`Response`** is patched to capture a `webSocket` init field and surface it
 *   (and a `101` status) without tripping Node's status-range check.
 *
 * The DO drives delivery through the hibernation API (`webSocketMessage` /
 * `webSocketClose` overrides), not `addEventListener`; {@link DurableObjectState}
 * bridges accepted sockets to those overrides.
 *
 * @see spec/self-hosting.md §7.4 (WebSocket hibernation)
 */

const PATCHED = Symbol.for("dwk.server.webSocketGlobalsInstalled");

/** A `data`-carrying event, avoiding reliance on Node's `MessageEvent` ctor. */
function dataEvent(type: string, data: unknown): Event {
  return Object.assign(new Event(type), { data });
}

/**
 * One end of a {@link WebSocketPair}: an `EventTarget` whose `send` delivers to
 * its peer's listeners. Implements just the surface the DO and the upgrade
 * bridge use (`send`, `close`, `accept`, `readyState`, events).
 */
export class EmulatedWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = EmulatedWebSocket.OPEN;
  #peer?: EmulatedWebSocket;

  /** Link the two ends (called by {@link WebSocketPair}). */
  _pair(peer: EmulatedWebSocket): void {
    this.#peer = peer;
  }

  /** workerd requires `accept()` on the non-hibernated path; a no-op here. */
  accept(): void {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== EmulatedWebSocket.OPEN) return;
    this.#peer?.dispatchEvent(dataEvent("message", data));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === EmulatedWebSocket.CLOSED) return;
    this.readyState = EmulatedWebSocket.CLOSED;
    this.dispatchEvent(
      Object.assign(new Event("close"), { code: code ?? 1000, reason }),
    );
    const peer = this.#peer;
    if (peer && peer.readyState !== EmulatedWebSocket.CLOSED) {
      peer.close(code, reason);
    }
  }
}

/** workerd's `WebSocketPair`: `pair[0]` is the client end, `pair[1]` the server. */
export class WebSocketPair {
  readonly 0: EmulatedWebSocket;
  readonly 1: EmulatedWebSocket;

  constructor() {
    const client = new EmulatedWebSocket();
    const server = new EmulatedWebSocket();
    client._pair(server);
    server._pair(client);
    this[0] = client;
    this[1] = server;
  }
}

/** Read the socket a DO attached to a `101` response, or `null`. */
export function responseWebSocket(
  response: Response,
): EmulatedWebSocket | null {
  return (
    (response as { webSocket?: EmulatedWebSocket | null }).webSocket ?? null
  );
}

/**
 * Install `WebSocketPair` and a `webSocket`-carrying `Response` as globals, once.
 */
export function installWebSocketGlobals(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[PATCHED]) return;
  g[PATCHED] = true;
  g.WebSocketPair = WebSocketPair;

  const Original = globalThis.Response;
  const sockets = new WeakMap<object, EmulatedWebSocket>();
  const status101 = new WeakSet<object>();

  class WebSocketResponse extends Original {
    constructor(...args: never[]) {
      const body = args[0] as BodyInit | null | undefined;
      const init = args[1] as
        | { webSocket?: EmulatedWebSocket; status?: number }
        | undefined;
      const ws = init?.webSocket;
      if (ws != null && init?.status === 101) {
        // Node forbids status 101 on Response; build a stand-in and remember it.
        super(body as never, { ...(init as object), status: 200 } as never);
        sockets.set(this, ws);
        status101.add(this);
      } else {
        super(body as never, init as never);
      }
    }

    override get webSocket(): WebSocket | null {
      return (sockets.get(this) ?? null) as WebSocket | null;
    }

    override get status(): number {
      return status101.has(this) ? 101 : super.status;
    }
  }
  globalThis.Response =
    WebSocketResponse as unknown as typeof globalThis.Response;
}
