export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  /** A Retry-After longer than this is clamped rather than honoured. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 8_000,
  maxRetryAfterMs: 30_000,
};

export type Outcome =
  | { kind: 'response'; status: number; retryAfter?: string | null }
  | { kind: 'network'; timedOut: boolean };

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/**
 * Whether a request may be retried at all: idempotent methods always, a POST only when the caller
 * declared it idempotent (an embeddings request is; Atlassian writes are not).
 */
export function canRetry(method: HttpMethod, idempotent = false): boolean {
  return IDEMPOTENT.has(method) || (idempotent && method === 'POST');
}

/** Retry-After as seconds or an HTTP-date, in milliseconds from `now`; undefined when unparsable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Full-jitter exponential backoff: `random() * min(cap, base * 2^(attempt-1))`. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

/**
 * The retry decision table : POST/PATCH are never retried; idempotent methods retry on
 * 429/502/503/504 and on network errors until `maxAttempts` is reached.
 */
export function decideRetry(
  input: {
    method: HttpMethod;
    attempt: number;
    outcome: Outcome;
    now?: number;
    idempotent?: boolean;
  },
  policy: RetryPolicy,
  random: () => number
): RetryDecision {
  const { method, attempt, outcome } = input;
  if (attempt >= policy.maxAttempts)
    return { retry: false, delayMs: 0, reason: 'attempts exhausted' };
  if (!canRetry(method, input.idempotent))
    return { retry: false, delayMs: 0, reason: `${method} is never retried` };

  if (outcome.kind === 'network') {
    return {
      retry: true,
      delayMs: backoffDelay(attempt, policy, random),
      reason: outcome.timedOut ? 'timeout' : 'network error',
    };
  }
  if (!RETRYABLE_STATUS.has(outcome.status)) {
    return { retry: false, delayMs: 0, reason: `status ${outcome.status} is not retryable` };
  }
  const retryAfter = parseRetryAfter(outcome.retryAfter, input.now ?? Date.now());
  const delayMs =
    retryAfter === undefined
      ? backoffDelay(attempt, policy, random)
      : Math.min(retryAfter, policy.maxRetryAfterMs);
  return { retry: true, delayMs, reason: `status ${outcome.status}` };
}
