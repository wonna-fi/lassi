import { fakeFetch } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createJiraClient } from './index.js';
import { readComments } from './comments.js';
import type { JiraComment } from './types.js';

const comment = (n: number): JiraComment => ({
  id: String(n),
  body: `comment ${n}`,
  created: new Date(n * 1000).toISOString(),
});
function setup() {
  const fetch = fakeFetch([
    {
      path: '/rest/api/2/issue/PROJ-1/comment',
      handler: (call) => {
        const startAt = Number(call.url.searchParams.get('startAt'));
        const maxResults = Math.min(2, Number(call.url.searchParams.get('maxResults')));
        const all = [1, 2, 3, 4, 5, 6, 7].map(comment);
        if (call.url.searchParams.get('orderBy') === '-created') all.reverse();
        return {
          json: {
            total: 7,
            startAt,
            maxResults,
            comments: all.slice(startAt, startAt + maxResults),
          },
        };
      },
    },
  ]);
  return {
    fetch,
    client: createJiraClient({ baseUrl: 'https://jira.example.internal', token: 'fixture', fetch }),
  };
}

describe('complete comment reads', () => {
  it('walks server-capped pages and returns every comment chronologically', async () => {
    const { client, fetch } = setup();
    const result = await client.readComments('PROJ-1');
    expect(result.comments.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(result).toMatchObject({ total: 7, incomplete: false, requested: 'all' });
    expect(fetch.calls.map((c) => c.url.searchParams.get('startAt'))).toEqual(['0', '2', '4', '6']);
  });

  it('selects the true newest N across pages and restores chronological order', async () => {
    const { client, fetch } = setup();
    const result = await client.readComments('PROJ-1', 3);
    expect(result.comments.map((c) => c.id)).toEqual(['5', '6', '7']);
    expect(result).toMatchObject({ total: 7, startAt: 4, incomplete: false, requested: 3 });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.every((c) => c.url.searchParams.get('orderBy') === '-created')).toBe(true);
  });

  it('reports premature empty pages and repeated pages as incomplete', async () => {
    for (const repeated of [false, true]) {
      let calls = 0;
      const result = await readComments(async ({ startAt }) => {
        calls++;
        return {
          total: 7,
          startAt,
          maxResults: 2,
          comments: startAt === 0 || repeated ? [comment(1), comment(2)] : [],
        };
      }, 'all');
      expect(result.incomplete).toBe(true);
      expect(result.comments).toHaveLength(2);
      expect(calls).toBe(2);
    }
  });

  it('reports a changing collection and caps unbounded reads', async () => {
    const result = await readComments(
      async ({ startAt, limit }) => ({
        total: startAt ? 6001 : 6000,
        startAt,
        maxResults: limit,
        comments: Array.from({ length: limit }, (_, i) => comment(startAt + i + 1)),
      }),
      'all'
    );
    expect(result.comments).toHaveLength(5000);
    expect(result.incomplete).toBe(true);
  });

  it('rejects invalid limits before reading and inconsistent offsets instead of looping', async () => {
    await expect(
      readComments(async () => {
        throw new Error('must not fetch');
      }, 1.5)
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      readComments(
        async () => ({ total: 1, startAt: 3, maxResults: 1, comments: [comment(1)] }),
        'all'
      )
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
