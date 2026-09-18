import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../testing/fake-fetch.js';
import { createHttpClient } from './client.js';
import { canRetry, decideRetry, DEFAULT_RETRY_POLICY } from './retry.js';

function make(
  routes: Parameters<typeof fakeFetch>[0],
  extra: { authScheme?: 'bearer' | 'api-key' } = {}
) {
  const fetch = fakeFetch(routes);
  const slept: number[] = [];
  const client = createHttpClient({
    baseUrl: 'https://embeddings.example.internal/v1',
    token: 'sk-secret',
    fetch,
    random: () => 0,
    sleep: async (ms) => void slept.push(ms),
    ...extra,
  });
  return { fetch, slept, client };
}

describe('auth scheme and idempotent POST', () => {
  it('sends api-key instead of a bearer header when asked', async () => {
    const bearer = make([{ method: 'POST', path: '/v1/embeddings', json: { data: [] } }]);
    await bearer.client.post('/embeddings', { input: ['x'] });
    expect(bearer.fetch.calls[0]?.headers['authorization']).toBe('Bearer sk-secret');
    expect(bearer.fetch.calls[0]?.headers['api-key']).toBeUndefined();
    const azure = make([{ method: 'POST', path: '/v1/embeddings', json: { data: [] } }], {
      authScheme: 'api-key',
    });
    await azure.client.post('/embeddings', { input: ['x'] });
    expect(azure.fetch.calls[0]?.headers['api-key']).toBe('sk-secret');
    expect(azure.fetch.calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('retries an idempotent POST on 429 honouring Retry-After, and never a plain POST', async () => {
    let calls = 0;
    const routes = [
      {
        method: 'POST',
        path: '/v1/embeddings',
        handler: () => {
          calls += 1;
          return calls === 1
            ? { status: 429, text: 'slow down', headers: { 'retry-after': '1' } }
            : { json: { data: [{ index: 0, embedding: [1, 0] }] } };
        },
      },
    ];
    const ok = make(routes);
    const result = await ok.client.post<{ data: unknown[] }>(
      '/embeddings',
      { input: ['x'] },
      { idempotent: true }
    );
    expect(result.data).toHaveLength(1);
    expect(ok.fetch.calls).toHaveLength(2);
    expect(ok.slept).toEqual([1000]);

    calls = 0;
    const plain = make(routes);
    await expect(plain.client.post('/embeddings', { input: ['x'] })).rejects.toMatchObject({
      http: 429,
    });
    expect(plain.fetch.calls).toHaveLength(1);
    expect(plain.slept).toEqual([]);
  });

  it('keeps the decision table honest', () => {
    expect(canRetry('GET')).toBe(true);
    expect(canRetry('POST')).toBe(false);
    expect(canRetry('POST', true)).toBe(true);
    expect(canRetry('PATCH', true)).toBe(false);
    const outcome = { kind: 'response' as const, status: 503 };
    expect(
      decideRetry({ method: 'POST', attempt: 1, outcome }, DEFAULT_RETRY_POLICY, () => 0).retry
    ).toBe(false);
    expect(
      decideRetry(
        { method: 'POST', attempt: 1, outcome, idempotent: true },
        DEFAULT_RETRY_POLICY,
        () => 0
      ).retry
    ).toBe(true);
  });
});
