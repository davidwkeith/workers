/**
 * Create a timeout signal that callers can release when their operation
 * settles. `AbortSignal.timeout()` leaves its timer pending after success,
 * which keeps a Durable Object's event loop alive unnecessarily.
 */
export function createTimeoutSignal(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly cancel: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}
