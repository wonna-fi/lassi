/**
 * Per-request deadline. `fetch` has no timeout of its own: a peer that accepts the connection and
 * then stalls holds the request open for as long as the socket lives.
 *
 * A deadline abort carries a DOMException named 'TimeoutError' (what `AbortSignal.timeout` aborts
 * with); caller cancellation carries 'AbortError'.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Composes the per-request deadline with an optional caller cancellation signal. The caller's
 * signal is listed first so an already-aborted caller wins with its own reason rather than a fresh
 * timeout.
 */
export function deadlineSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

export interface Deadline {
  signal: AbortSignal;
  /** Stops the timer. A streaming body then runs under the caller's signal alone. */
  clear(): void;
}

/**
 * The same composition, but stoppable: a download's deadline must cover the headers only, or every
 * transfer slower than `timeoutMs` would be aborted midway and reported as an endpoint timeout.
 */
export function createDeadline(timeoutMs: number, callerSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`request timed out after ${timeoutMs} ms`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function abortName(err: unknown): 'TimeoutError' | 'AbortError' | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return name;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeName = (cause as { name?: unknown }).name;
    if (causeName === 'TimeoutError' || causeName === 'AbortError') return causeName;
  }
  return undefined;
}

/** True only for a deadline abort (`AbortSignal.timeout` fired). Structural: wrapped errors count. */
export function isTimeoutError(err: unknown): boolean {
  return abortName(err) === 'TimeoutError';
}

/** True for any abort: caller cancellation ('AbortError') or deadline ('TimeoutError'). */
export function isAbortError(err: unknown): boolean {
  return abortName(err) !== undefined;
}
