import { describe, expect, it } from 'vitest';
import { fakeFetch, type Route } from '@wonna/lassi-core/testing';
import { createHttpClient } from './client.js';

const BASE = 'https://jira.example.internal';

function client(routes: Route[], token = 'pat-token', authScheme?: 'bearer' | 'api-key') {
  const fetch = fakeFetch(routes);
  return {
    fetch,
    c: createHttpClient({
      baseUrl: BASE,
      token,
      fetch,
      random: () => 0,
      sleep: async () => {},
      ...(authScheme ? { authScheme } : {}),
    }),
  };
}

describe('redirects', () => {
  it('follows a same-origin GET redirect', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/2/myself',
        status: 302,
        text: '',
        headers: { location: '/rest/api/2/whoami' },
      },
      { path: '/rest/api/2/whoami', json: { name: 'jsmith' } },
    ]);
    expect(await c.get('/rest/api/2/myself')).toEqual({ name: 'jsmith' });
    expect(fetch.calls.map((call) => call.url.pathname)).toEqual([
      '/rest/api/2/myself',
      '/rest/api/2/whoami',
    ]);
  });

  it('refuses a cross-origin redirect instead of handing the credential to another host', async () => {
    const { c, fetch } = client(
      [
        {
          path: '/v1/embeddings',
          status: 302,
          text: '',
          headers: { location: 'https://collector.example.com/collected' },
        },
      ],
      'SECRET-api-key',
      'api-key'
    );
    await expect(c.get('/v1/embeddings')).rejects.toMatchObject({
      code: 'http',
      http: 302,
      message: expect.stringContaining(
        'refusing to follow a redirect to https://collector.example.com'
      ),
    });
    // Only the first request went out; nothing reached the other origin.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers['api-key']).toBe('SECRET-api-key');
  });

  it('does not repeat a redirected write', async () => {
    const { c } = client([
      {
        method: 'POST',
        path: '/rest/api/2/issue',
        status: 307,
        text: '',
        headers: { location: '/elsewhere' },
      },
    ]);
    await expect(c.post('/rest/api/2/issue', { fields: {} })).rejects.toMatchObject({
      code: 'http',
      message: expect.stringContaining('redirected a POST'),
    });
  });
});

describe('a 200 that is not JSON', () => {
  it('is an HTTP error naming the likely cause, not a parser crash', async () => {
    const { c } = client([
      {
        path: '/rest/api/2/issue/PROJ-1',
        text: '<html>login</html>',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      },
    ]);
    await expect(c.get('/rest/api/2/issue/PROJ-1')).rejects.toMatchObject({
      code: 'http',
      http: 200,
      request: { method: 'GET', url: '/rest/api/2/issue/PROJ-1' },
      hint: expect.stringContaining('SSO login page'),
    });
  });
});

describe('download deadlines', () => {
  it('covers the headers only, so a slow body is not aborted as a timeout', async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const fetch = ((): typeof globalThis.fetch => {
      const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            if (signal?.aborted) {
              controller.error(signal.reason);
              return;
            }
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-length': '3' } });
      };
      return impl as unknown as typeof globalThis.fetch;
    })();
    const c = createHttpClient({ baseUrl: BASE, token: 't', fetch, timeoutMs: 20 });
    const result = await c.download('/secure/attachment/1/big.bin');
    expect(result.status).toBe(200);
    // Well past the deadline, the body still streams: it runs under the caller's signal now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    released?.();
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array([1, 2, 3]));
  });
});
