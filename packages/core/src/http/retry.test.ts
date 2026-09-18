import { describe, expect, it } from 'vitest';
import { backoffDelay, decideRetry, DEFAULT_RETRY_POLICY, parseRetryAfter } from './retry.js';

const policy = DEFAULT_RETRY_POLICY;
const half = (): number => 0.5;

describe('decideRetry', () => {
  it.each([
    ['GET', 503, true],
    ['GET', 502, true],
    ['GET', 504, true],
    ['GET', 429, true],
    ['GET', 500, false],
    ['GET', 400, false],
    ['PUT', 503, true],
    ['DELETE', 503, true],
    ['HEAD', 503, true],
    ['POST', 503, false],
    ['PATCH', 503, false],
    ['POST', 429, false],
  ] as const)('%s on %i → retry=%s', (method, status, expected) => {
    expect(
      decideRetry({ method, attempt: 1, outcome: { kind: 'response', status } }, policy, half).retry
    ).toBe(expected);
  });

  it('retries idempotent methods on network errors and timeouts, never POST', () => {
    expect(
      decideRetry(
        { method: 'GET', attempt: 1, outcome: { kind: 'network', timedOut: true } },
        policy,
        half
      )
    ).toEqual({
      retry: true,
      delayMs: 250,
      reason: 'timeout',
    });
    expect(
      decideRetry(
        { method: 'POST', attempt: 1, outcome: { kind: 'network', timedOut: false } },
        policy,
        half
      ).retry
    ).toBe(false);
  });

  it('stops when attempts are exhausted', () => {
    expect(
      decideRetry(
        { method: 'GET', attempt: 3, outcome: { kind: 'response', status: 503 } },
        policy,
        half
      )
    ).toMatchObject({
      retry: false,
      reason: 'attempts exhausted',
    });
  });

  it('honours Retry-After (seconds and HTTP-date) with a clamp', () => {
    const now = Date.parse('2026-09-04T10:00:00Z');
    expect(
      decideRetry(
        {
          method: 'GET',
          attempt: 1,
          outcome: { kind: 'response', status: 429, retryAfter: '2' },
          now,
        },
        policy,
        half
      ).delayMs
    ).toBe(2000);
    expect(
      decideRetry(
        {
          method: 'GET',
          attempt: 1,
          outcome: { kind: 'response', status: 503, retryAfter: 'Thu, 04 Sep 2026 10:00:05 GMT' },
          now,
        },
        policy,
        half
      ).delayMs
    ).toBe(5000);
    expect(
      decideRetry(
        {
          method: 'GET',
          attempt: 1,
          outcome: { kind: 'response', status: 429, retryAfter: '3600' },
          now,
        },
        policy,
        half
      ).delayMs
    ).toBe(30_000);
    expect(
      decideRetry(
        {
          method: 'GET',
          attempt: 1,
          outcome: { kind: 'response', status: 429, retryAfter: 'soon' },
          now,
        },
        policy,
        half
      ).delayMs
    ).toBe(250);
  });
});

describe('backoff and Retry-After parsing', () => {
  it('uses full jitter under an exponential ceiling', () => {
    expect(backoffDelay(1, policy, () => 1)).toBe(500);
    expect(backoffDelay(2, policy, () => 1)).toBe(1000);
    expect(backoffDelay(10, policy, () => 1)).toBe(8000);
    expect(backoffDelay(2, policy, () => 0)).toBe(0);
  });

  it('parses seconds and dates, rejects garbage', () => {
    expect(parseRetryAfter('10', 0)).toBe(10_000);
    expect(parseRetryAfter(' 3 ', 0)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:02 GMT', 1000)).toBe(1000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 5000)).toBe(0);
    expect(parseRetryAfter('nonsense', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
