import { fakeFetch } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createJiraClient } from './index.js';

const ISSUES = Array.from({ length: 7 }, (_, i) => ({
  id: String(i + 1),
  key: `PROJ-${i + 1}`,
  fields: { summary: `Issue ${i + 1}`, updated: '2026-09-01T10:00:00.000+0300' },
}));

describe('searchPages', () => {
  it('yields one page at a time with the page-level names and schema, and reports the cap', async () => {
    const fetch = fakeFetch([
      {
        method: 'POST',
        path: '/rest/api/2/search',
        handler: (call) => {
          const body = JSON.parse(call.bodyText ?? '{}') as { startAt: number; maxResults: number };
          return {
            json: {
              startAt: body.startAt,
              maxResults: body.maxResults,
              total: ISSUES.length,
              issues: ISSUES.slice(body.startAt, body.startAt + body.maxResults),
              names: { customfield_10005: 'Story Points' },
              schema: { customfield_10005: { type: 'number' } },
            },
          };
        },
      },
    ]);
    const client = createJiraClient({
      baseUrl: 'https://jira.example.internal',
      token: 't',
      fetch,
    });
    const pages = client.searchPages({
      jql: 'project = PROJ',
      pageSize: 3,
      expand: ['names', 'schema'],
    });
    const seen: number[] = [];
    let result: { total: number; truncated: boolean } | undefined;
    for (;;) {
      const step = await pages.next();
      if (step.done) {
        result = step.value;
        break;
      }
      seen.push(step.value.issues.length);
      expect(step.value.names).toEqual({ customfield_10005: 'Story Points' });
    }
    expect(seen).toEqual([3, 3, 1]);
    expect(result).toEqual({ total: 7, truncated: false });
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '{}')).toMatchObject({
      expand: ['names', 'schema'],
    });

    const capped = client.searchPages({ jql: 'project = PROJ', pageSize: 3, cap: 4 });
    let last: { total: number; truncated: boolean } | undefined;
    const sizes: number[] = [];
    for (;;) {
      const step = await capped.next();
      if (step.done) {
        last = step.value;
        break;
      }
      sizes.push(step.value.issues.length);
    }
    expect(sizes).toEqual([3, 1]);
    expect(last).toEqual({ total: 7, truncated: true });
  });
});

it('retries read-only search POSTs after a transient server failure', async () => {
  const fetch = fakeFetch([
    { path: '/rest/api/2/search', times: 1, status: 503, json: { errorMessages: ['temporary'] } },
    { path: '/rest/api/2/search', json: { issues: [], total: 0, startAt: 0, maxResults: 100 } },
  ]);
  const client = createJiraClient({
    baseUrl: 'https://jira.example.internal',
    token: 'fixture',
    fetch,
    sleep: async () => {},
    random: () => 0,
  });
  expect((await client.search({ jql: 'project = PROJ' })).issues).toEqual([]);
  expect(fetch.calls).toHaveLength(2);
});
