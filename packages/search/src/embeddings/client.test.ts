import { createHttpClient, createLogger } from '@wonna/lassi-core';
import { fakeFetch, type Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createEmbeddingsClient } from './client.js';

function make(
  routes: Route[],
  opts: {
    apiVersion?: string;
    dimensions?: number;
    batchSize?: number;
    authScheme?: 'bearer' | 'api-key';
  } = {}
) {
  const fetch = fakeFetch(routes);
  const slept: number[] = [];
  const lines: string[] = [];
  const http = createHttpClient({
    baseUrl: 'https://embeddings.example.internal/v1',
    token: 'sk-secret',
    fetch,
    random: () => 0,
    sleep: async (ms) => void slept.push(ms),
    ...(opts.authScheme ? { authScheme: opts.authScheme } : {}),
  });
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(l), redact: (s) => s });
  const client = createEmbeddingsClient({
    http,
    model: 'text-embedding-3-small',
    logger,
    ...(opts.apiVersion === undefined ? {} : { apiVersion: opts.apiVersion }),
    ...(opts.dimensions === undefined ? {} : { dimensions: opts.dimensions }),
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
  });
  return { fetch, slept, lines, client };
}

/** Answers with 4-dim vectors derived from each input, in shuffled order to prove sorting. */
const echo: Route = {
  method: 'POST',
  path: '/v1/embeddings',
  handler: (call) => {
    const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
    const data = input.map((text, index) => ({ index, embedding: [text.length, 1, 0, index] }));
    return { json: { data: data.reverse(), model: 'text-embedding-3-small' } };
  },
};

describe('createEmbeddingsClient', () => {
  it('posts the OpenAI shape, batches, keeps input order and never logs the inputs', async () => {
    const texts = Array.from({ length: 65 }, (_, i) => `text number ${i} private-content`);
    const { fetch, lines, client } = make([echo], { batchSize: 64 });
    const vectors = await client.embed(texts);
    expect(fetch.calls).toHaveLength(2);
    const first = JSON.parse(fetch.calls[0]?.bodyText ?? '{}') as {
      model: string;
      input: string[];
    };
    expect(first.model).toBe('text-embedding-3-small');
    expect(first.input).toHaveLength(64);
    expect(fetch.calls[0]?.headers['authorization']).toBe('Bearer sk-secret');
    expect(vectors).toHaveLength(65);
    expect(Array.from(vectors[3] ?? [])).toEqual([texts[3]?.length, 1, 0, 3]);
    expect(Array.from(vectors[64] ?? [])).toEqual([texts[64]?.length, 1, 0, 0]);
    expect(lines.join('')).not.toContain('private-content');
    expect(lines.join('')).toContain('embeddings: batch of 64 (64/65)');
  });

  it('adds api-version and dimensions for Azure-style deployments', async () => {
    const { fetch, client } = make([echo], {
      apiVersion: '2024-02-01',
      dimensions: 4,
      authScheme: 'api-key',
    });
    await client.embed(['x']);
    expect(fetch.calls[0]?.url.searchParams.get('api-version')).toBe('2024-02-01');
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '{}')).toMatchObject({ dimensions: 4 });
    expect(fetch.calls[0]?.headers['api-key']).toBe('sk-secret');
  });

  it('retries a 429 with Retry-After because the request is idempotent', async () => {
    let n = 0;
    const flaky: Route = {
      method: 'POST',
      path: '/v1/embeddings',
      handler: (call) => {
        n += 1;
        if (n === 1) return { status: 429, text: 'busy', headers: { 'retry-after': '1' } };
        return echo.handler?.(call) ?? { json: {} };
      },
    };
    const { fetch, slept, client } = make([flaky]);
    expect(await client.embed(['a'])).toHaveLength(1);
    expect(fetch.calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it('refuses count mismatches and dimension drift', async () => {
    const short = make([
      { method: 'POST', path: '/v1/embeddings', json: { data: [{ index: 0, embedding: [1, 2] }] } },
    ]);
    await expect(short.client.embed(['a', 'b'])).rejects.toMatchObject({
      code: 'validation',
      message: 'embeddings endpoint returned 1 vectors for 2 inputs',
    });
    const drift = make([
      {
        method: 'POST',
        path: '/v1/embeddings',
        json: {
          data: [
            { index: 0, embedding: [1, 2] },
            { index: 1, embedding: [1, 2, 3] },
          ],
        },
      },
    ]);
    await expect(drift.client.embed(['a', 'b'])).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('3-dimensional vectors after 2-dimensional'),
    });
    const pinned = make(
      [
        {
          method: 'POST',
          path: '/v1/embeddings',
          json: { data: [{ index: 0, embedding: [1, 2] }] },
        },
      ],
      {
        dimensions: 3,
      }
    );
    await expect(pinned.client.embed(['a'])).rejects.toMatchObject({
      code: 'validation',
      // The endpoint never returned a 3-dimensional vector, so the old wording sent the user off to
      // pin a setting they had already pinned.
      message: expect.stringContaining('embeddings.dimensions is 3 but the endpoint returned 2'),
    });
  });

  it('refuses a vector carrying anything that is not a finite number', async () => {
    for (const embedding of [
      [1, 'x'],
      [1, null],
      [1, Number.NaN],
    ]) {
      const t = make([
        { method: 'POST', path: '/v1/embeddings', json: { data: [{ index: 0, embedding }] } },
      ]);
      // A NaN survives normalisation and no comparison rejects it, so one in the stored matrix
      // makes the similarity floor stop being a floor for every later query.
      await expect(t.client.embed(['a'])).rejects.toMatchObject({
        code: 'validation',
        message: expect.stringContaining('not a finite number'),
      });
    }
  });
});
