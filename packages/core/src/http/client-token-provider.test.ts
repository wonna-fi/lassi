import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { createHttpClient } from './client.js';

describe('token provider', () => {
  it('asks the provider before every attempt, so a retry after a 503 carries a refreshed token', async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetch = fakeFetch([
      { path: '/rest/api/2/myself', status: 503, text: 'busy', times: 1 },
      { path: '/rest/api/2/myself', json: { ok: true } },
    ]);
    const client = createHttpClient({
      baseUrl: 'https://jira.example.internal',
      token: async () => `token-${++calls}`,
      fetch,
      random: () => 0,
      sleep: async (ms) => void slept.push(ms),
    });
    await client.get('/rest/api/2/myself');
    expect(calls).toBe(2);
    expect(slept).toHaveLength(1);
    expect(fetch.calls.map((c) => c.headers['authorization'])).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('acquires the token before the clock starts, so a slow provider never counts as a timeout', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l), redact: (s) => s });
    let clock = 0;
    const fetch = fakeFetch([{ path: '/x', json: {} }]);
    const client = createHttpClient({
      baseUrl: 'https://jira.example.internal',
      token: async () => {
        clock += 50_000;
        return 'slow-token';
      },
      fetch,
      logger,
      timeoutMs: 100,
      now: () => clock,
    });
    await client.get('/x');
    expect(fetch.calls).toHaveLength(1);
    expect(lines).toEqual(['debug: -> GET /x (attempt 1/3)\n', 'debug: <- 200 GET /x 0ms\n']);
  });

  it('turns a failing provider into a one-line auth error before anything is sent or traced', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (l) => lines.push(l), redact: (s) => s });
    const fetch = fakeFetch([{ path: '/x', json: {} }]);
    const client = createHttpClient({
      baseUrl: 'https://jira.example.internal',
      token: async () => {
        throw new Error('chain failed.\n  first credential unavailable\n  az login required');
      },
      fetch,
      logger,
    });
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'auth',
      message:
        'could not obtain a token: chain failed. first credential unavailable az login required',
    });
    expect(fetch.calls).toHaveLength(0);
    expect(lines).toEqual([]);
  });
});
