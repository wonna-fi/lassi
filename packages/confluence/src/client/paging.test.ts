import { fakeFetch, type Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createConfluenceClient } from './index.js';

const BASE = 'https://confluence.example.internal';

function client(routes: Route[]) {
  const fetch = fakeFetch(routes);
  return { fetch, c: createConfluenceClient({ baseUrl: BASE, token: 'pat-token-1234', fetch }) };
}

/**
 * Confluence pages by position in the unfiltered result set: a page the reader may not see is
 * dropped from `results` but still consumes a position, so a short page can carry a next link.
 */
function filteredSearch(hidden: number, total = 8): Route {
  const rows = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1),
    type: 'page',
    title: `Page ${i + 1}`,
  }));
  return {
    path: '/rest/api/content/search',
    handler: (call) => {
      const start = Number(call.url.searchParams.get('start'));
      const limit = Number(call.url.searchParams.get('limit'));
      const window = rows.slice(start, start + limit);
      const visible = window.filter((_, i) => start + i !== hidden);
      const nextStart = start + limit;
      return {
        json: {
          results: visible,
          start,
          limit,
          size: visible.length,
          totalSize: total,
          ...(nextStart < total
            ? {
                _links: {
                  next: `/rest/api/content/search?cql=x&start=${nextStart}&limit=${limit}`,
                },
              }
            : {}),
        },
      };
    },
  };
}

describe('search paging', () => {
  it('follows the next link instead of stepping by the rows received, so nothing repeats', async () => {
    const { c, fetch } = client([filteredSearch(1)]);
    const all = await c.searchAll('type = page', { pageSize: 4 });
    const ids = all.results.map((r) => r.id);
    expect(ids).toEqual(['1', '3', '4', '5', '6', '7', '8']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fetch.calls.map((call) => call.url.searchParams.get('start'))).toEqual(['0', '4']);
  });

  it('keeps reading when a whole page is filtered away but a next link follows', async () => {
    const rows = [{ id: '9', type: 'page', title: 'Visible' }];
    const { c } = client([
      {
        path: '/rest/api/content/search',
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          return start === 0
            ? {
                json: {
                  results: [],
                  start: 0,
                  limit: 4,
                  size: 0,
                  _links: { next: '/rest/api/content/search?cql=x&start=4&limit=4' },
                },
              }
            : { json: { results: rows, start, limit: 4, size: 1 } };
        },
      },
    ]);
    const all = await c.searchAll('type = page', { pageSize: 4 });
    expect(all.results.map((r) => r.id)).toEqual(['9']);
    expect(all.truncated).toBe(false);
  });

  it('walks children the same way', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/content/123456/child/attachment',
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          const limit = Number(call.url.searchParams.get('limit'));
          return start === 0
            ? {
                json: {
                  results: [{ id: 'a1', title: 'a1.png' }],
                  start,
                  limit,
                  size: 1,
                  _links: { next: `/rest/api/content/123456/child/attachment?start=${limit}` },
                },
              }
            : { json: { results: [{ id: 'a2', title: 'a2.png' }], start, limit, size: 1 } };
        },
      },
    ]);
    const { items, truncated } = await c.children('123456', 'attachment');
    expect(items.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(truncated).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('convertBody', () => {
  it('refuses a 200 that is not the documented JSON, so a login page cannot read as valid', async () => {
    const { c } = client([
      {
        method: 'POST',
        path: '/rest/api/contentbody/convert/view',
        text: '<html><body>Please log in</body></html>',
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      },
    ]);
    await expect(c.convertBody('<p>x</p>', 'storage', 'view')).rejects.toMatchObject({
      code: 'http',
      message: expect.stringContaining('text/html body that is not JSON'),
      hint: expect.stringContaining('SSO login page'),
    });
  });

  it('returns the converted value when the endpoint answers properly', async () => {
    const { c } = client([
      { method: 'POST', path: '/rest/api/contentbody/convert/view', json: { value: '<p>ok</p>' } },
    ]);
    expect(await c.convertBody('<p>x</p>')).toBe('<p>ok</p>');
  });

  it('says so when the child walk stops at its cap', async () => {
    // The cap was silent: `tree` reported `truncated: false` and the page trailer named the capped
    // number as if it were the total.
    const { c } = client([
      {
        path: /^\/rest\/api\/content\/\d+\/child\/page/,
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          const limit = Number(call.url.searchParams.get('limit'));
          return {
            json: {
              results: Array.from({ length: limit }, (_, i) => ({
                id: String(start + i + 1000),
                title: `Child ${start + i}`,
              })),
              start,
              limit,
              size: limit,
              _links: { next: `/rest/api/content/1/child/page?start=${start + limit}` },
            },
          };
        },
      },
      { path: '/rest/api/content/1', json: { id: '1', type: 'page', title: 'Root' } },
    ]);
    const walked = await c.children('1', 'page');
    expect(walked.truncated).toBe(true);
    expect(walked.items).toHaveLength(1000);
    // Which cap fired, not just that one did: the two stop the walk far apart and the CLI says
    // different things about them.
    const tree = await c.tree({ pageId: '1' }, { depth: 1, maxNodes: 5000 });
    expect(tree.truncated).toEqual(['children']);
    // Both caps can fire on one walk, and raising maxNodes does nothing about the other one.
    const capped = await c.tree({ pageId: '1' }, { depth: 1, maxNodes: 10 });
    expect([...capped.truncated].sort()).toEqual(['children', 'nodes']);
    // The exact boundary: the root plus 1000 capped children fills a budget of 1001 on the last
    // one, so the loop ends without another iteration to notice. Both caps are still live.
    const exact = await c.tree({ pageId: '1' }, { depth: 1, maxNodes: 1001 });
    expect([...exact.truncated].sort()).toEqual(['children', 'nodes']);
  });

  it('reports the cap from the list helpers too', async () => {
    // Three walks share walkChildren, and only `children` used to report the cap; a page get with
    // --comments would present the first 1000 as the whole discussion.
    const { c } = client([
      {
        path: /^\/rest\/api\/content\/\d+\/child\/comment/,
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          const limit = Number(call.url.searchParams.get('limit'));
          return {
            json: {
              results: Array.from({ length: limit }, (_, i) => ({ id: String(start + i + 1) })),
              start,
              limit,
              size: limit,
              _links: { next: `/rest/api/content/1/child/comment?start=${start + limit}` },
            },
          };
        },
      },
    ]);
    const listed = await c.listComments('1');
    expect(listed.truncated).toBe(true);
    expect(listed.items).toHaveLength(1000);
  });

  it('marks only the counts that are floors', async () => {
    // One capped kind used to put a `+` on all three, so a page with 1001 children reported its
    // two comments as "2+".
    const { c } = client([
      {
        path: /^\/rest\/api\/content\/\d+\/child\/page/,
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          const limit = Number(call.url.searchParams.get('limit'));
          return {
            json: {
              results: Array.from({ length: limit }, (_, i) => ({ id: String(start + i + 9000) })),
              start,
              limit,
              size: limit,
              _links: { next: `/rest/api/content/1/child/page?start=${start + limit}` },
            },
          };
        },
      },
      {
        path: /^\/rest\/api\/content\/\d+\/child\/comment/,
        json: { results: [{ id: 'c1' }], size: 1, limit: 200 },
      },
      {
        path: /^\/rest\/api\/content\/\d+\/child\/attachment/,
        json: { results: [], size: 0, limit: 200 },
      },
      {
        path: '/rest/api/content/1',
        json: {
          id: '1',
          type: 'page',
          title: 'Root',
          children: {
            page: { results: [], size: 25, limit: 25 },
            comment: { results: [], size: 25, limit: 25 },
            attachment: { results: [], size: 0, limit: 25 },
          },
        },
      },
    ]);
    const page = await c.getPage('1');
    expect(page.counts.children).toBe(1000);
    expect(page.counts.comments).toBe(1);
    expect(page.counts.truncated).toEqual(['children']);
  });
});
