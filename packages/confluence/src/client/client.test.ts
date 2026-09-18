import { PassThrough } from 'node:stream';
import { fakeFetch, type Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createConfluenceClient, parseManifestVersion } from './index.js';

const BASE = 'https://confluence.example.internal';

function client(routes: Route[], downloadUrlSuffix?: string) {
  const fetch = fakeFetch(routes);
  const c = createConfluenceClient({
    baseUrl: BASE,
    token: 'pat-token-1234',
    fetch,
    random: () => 0,
    sleep: async () => {},
    ...(downloadUrlSuffix === undefined ? {} : { downloadUrlSuffix }),
  });
  return { c, fetch };
}

const PAGE = {
  id: '123456',
  type: 'page',
  title: 'Payment design',
  space: { key: 'DEV', name: 'Development' },
  version: { number: 12, when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } },
  ancestors: [{ id: '100' }, { id: '123400' }],
  body: { storage: { value: '<p>Hello</p>', representation: 'storage' } },
  history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } } },
  children: {
    page: { results: [{ id: '1' }, { id: '2' }], size: 2, limit: 25, start: 0 },
    comment: { results: [], size: 0, limit: 25, start: 0 },
    attachment: { results: [{ id: '9' }], size: 1, limit: 1, start: 0 },
  },
};

describe('createConfluenceClient', () => {
  it('reads the current user and turns an anonymous answer into an auth error', async () => {
    const ok = client([
      {
        path: '/rest/api/user/current',
        json: { type: 'known', username: 'jsmith', userKey: 'k1' },
      },
    ]);
    expect(await ok.c.currentUser()).toMatchObject({ username: 'jsmith' });
    const anon = client([
      { path: '/rest/api/user/current', json: { type: 'anonymous', displayName: 'Anonymous' } },
    ]);
    await expect(anon.c.currentUser()).rejects.toMatchObject({ code: 'auth' });
  });

  it('falls back from systemInfo to the applinks manifest and then to a space probe', async () => {
    const info = client([{ path: '/rest/api/settings/systemInfo', json: { version: '8.5.10' } }]);
    expect(await info.c.systemInfo()).toEqual({ version: '8.5.10', source: 'systemInfo' });
    const manifest = client([
      {
        path: '/rest/api/settings/systemInfo',
        status: 403,
        json: { statusCode: 403, message: 'admin only' },
      },
      {
        path: '/rest/applinks/1.0/manifest',
        text: '<manifest><version>9.2.1</version></manifest>',
        headers: { 'content-type': 'application/xml' },
      },
    ]);
    expect(await manifest.c.systemInfo()).toEqual({ version: '9.2.1', source: 'manifest' });
    const probe = client([
      { path: '/rest/api/settings/systemInfo', status: 404, text: 'no' },
      { path: '/rest/applinks/1.0/manifest', status: 404, text: 'no' },
      { path: '/rest/api/space', json: { results: [], size: 0 } },
    ]);
    expect(await probe.c.systemInfo()).toEqual({ source: 'space-probe' });
    const unauth = client([{ path: '/rest/api/settings/systemInfo', status: 401, text: 'nope' }]);
    await expect(unauth.c.systemInfo()).rejects.toMatchObject({ code: 'auth' });
    expect(parseManifestVersion('{"version":"7.19.0"}')).toBe('7.19.0');
    expect(parseManifestVersion('garbage')).toBeUndefined();
  });

  it('gets a page with counts, walking children only when the expand was cut off', async () => {
    const { c, fetch } = client([
      { path: '/rest/api/content/123456', json: PAGE },
      {
        path: '/rest/api/content/123456/child/attachment',
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          return start === 0
            ? { json: { results: [{ id: '9' }, { id: '10' }], size: 2, _links: { next: '/x' } } }
            : { json: { results: [{ id: '11' }], size: 1 } };
        },
      },
    ]);
    const page = await c.getPage('123456');
    expect(page.counts).toEqual({ children: 2, comments: 0, attachments: 3 });
    expect(fetch.calls[0]?.url.searchParams.get('expand')).toContain('body.storage');
    expect(
      fetch.calls.filter((call) => call.url.pathname.endsWith('/child/attachment'))
    ).toHaveLength(2);
    expect(fetch.calls.some((call) => call.url.pathname.endsWith('/child/page'))).toBe(false);
  });

  it('resolves references by id, by SPACE:Title and reports a missing title as not found', async () => {
    const { c, fetch } = client([
      { path: '/rest/api/content/123456', json: PAGE },
      // The fixture's attachment expand is cut off (size === limit), so the count walk runs.
      {
        path: '/rest/api/content/123456/child/attachment',
        json: { results: [{ id: '9' }], size: 1 },
      },
      {
        path: '/rest/api/content',
        handler: (call) =>
          call.url.searchParams.get('title') === 'Payment design'
            ? { json: { results: [PAGE], size: 1 } }
            : { json: { results: [], size: 0 } },
      },
    ]);
    expect((await c.resolvePageRef('123456')).id).toBe('123456');
    expect((await c.resolvePageRef('DEV:Payment design')).title).toBe('Payment design');
    expect(
      fetch.calls
        .find((call) => call.url.pathname === '/rest/api/content')
        ?.url.searchParams.get('spaceKey')
    ).toBe('DEV');
    await expect(c.resolvePageRef('DEV:Nope')).rejects.toMatchObject({
      code: 'not_found',
      hint: expect.stringContaining('lassi confluence search'),
    });
    expect(c.pageUrl('123456')).toBe(`${BASE}/pages/viewpage.action?pageId=123456`);
  });

  it('searches with CQL, pages by start and stops at the cap or when next is absent', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/content/search',
        handler: (call) => {
          const start = Number(call.url.searchParams.get('start'));
          const limit = Number(call.url.searchParams.get('limit'));
          const all = Array.from({ length: 7 }, (_, i) => ({
            id: String(i + 1),
            type: 'page',
            title: `P${i + 1}`,
          }));
          const slice = all.slice(start, start + limit);
          return {
            json: {
              results: slice,
              start,
              limit,
              size: slice.length,
              totalSize: 7,
              ...(start + slice.length < 7 ? { _links: { next: '/n' } } : {}),
            },
          };
        },
      },
    ]);
    const first = await c.search('type = page', { limit: 3 });
    expect(first).toMatchObject({ size: 3, totalSize: 7, next: true });
    expect(fetch.calls[0]?.url.searchParams.get('cql')).toBe('type = page');
    const all = await c.searchAll('type = page', { pageSize: 3 });
    expect(all.results.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(all).toMatchObject({ truncated: false, total: 7 });
    const capped = await c.searchAll('type = page', { pageSize: 3, max: 4 });
    expect(capped.results).toHaveLength(4);
    expect(capped.truncated).toBe(true);
  });

  it('builds a page tree breadth-first with a depth limit, from a page or a space homepage', async () => {
    const { c } = client([
      { path: '/rest/api/space/DEV', json: { key: 'DEV', homepage: { id: '1', title: 'Home' } } },
      { path: '/rest/api/content/1', json: { id: '1', title: 'Home' } },
      {
        path: '/rest/api/content/1/child/page',
        json: {
          results: [
            { id: '2', title: 'A' },
            { id: '3', title: 'B' },
          ],
          size: 2,
        },
      },
      {
        path: '/rest/api/content/2/child/page',
        json: { results: [{ id: '4', title: 'A1' }], size: 1 },
      },
      { path: '/rest/api/content/3/child/page', json: { results: [], size: 0 } },
      {
        path: '/rest/api/content/4/child/page',
        json: { results: [{ id: '5', title: 'deep' }], size: 1 },
      },
    ]);
    const bySpace = await c.tree({ spaceKey: 'DEV' }, { depth: 2 });
    expect(bySpace.root).toEqual({
      id: '1',
      title: 'Home',
      children: [
        { id: '2', title: 'A', children: [{ id: '4', title: 'A1', children: [] }] },
        { id: '3', title: 'B', children: [] },
      ],
    });
    const byPage = await c.tree({ pageId: '1' }, { depth: 1 });
    expect(byPage.root.children.map((n) => n.id)).toEqual(['2', '3']);
    expect(byPage.root.children[0]?.children).toEqual([]);
  });

  it('creates and updates pages with the next version and maps a 409 to conflict', async () => {
    const { c, fetch } = client([
      {
        method: 'POST',
        path: '/rest/api/content',
        json: { id: '777', type: 'page', title: 'New' },
      },
      {
        method: 'PUT',
        path: '/rest/api/content/123456',
        handler: (call) => {
          const body = JSON.parse(call.bodyText ?? '{}') as { version: { number: number } };
          return body.version.number === 13
            ? { json: { id: '123456', type: 'page', title: 'T', version: { number: 13 } } }
            : {
                status: 409,
                json: { statusCode: 409, message: 'Version must be incremented on update' },
              };
        },
      },
    ]);
    await c.createPage({ space: 'DEV', title: 'New', parentId: '100', storage: '<p>x</p>' });
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '')).toEqual({
      type: 'page',
      title: 'New',
      space: { key: 'DEV' },
      ancestors: [{ id: '100' }],
      body: { storage: { value: '<p>x</p>', representation: 'storage' } },
    });
    const updated = await c.updatePage('123456', {
      title: 'T',
      currentVersion: 12,
      storage: '<p>y</p>',
    });
    expect(updated.version?.number).toBe(13);
    expect(JSON.parse(fetch.calls[1]?.bodyText ?? '')).toMatchObject({
      id: '123456',
      version: { number: 13 },
    });
    await expect(c.updatePage('123456', { title: 'T', currentVersion: 11 })).rejects.toMatchObject({
      code: 'conflict',
      context: { pageId: '123456', versionFrom: 11, versionTo: 12 },
    });
  });

  it('lists, creates, reads and deletes comments', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/content/123456/child/comment',
        json: {
          results: [
            {
              id: '5',
              type: 'comment',
              title: 'Re',
              body: { storage: { value: '<p>hi</p>', representation: 'storage' } },
              history: {
                createdBy: { username: 'jsmith' },
                createdDate: '2026-09-02T10:00:00.000+0300',
              },
              version: { number: 1 },
            },
          ],
          size: 1,
        },
      },
      {
        method: 'POST',
        path: '/rest/api/content',
        json: { id: '6', type: 'comment', title: 'Re' },
      },
      {
        method: 'GET',
        path: '/rest/api/content/6',
        json: { id: '6', type: 'comment', title: 'Re' },
      },
      { method: 'DELETE', path: '/rest/api/content/6', status: 204 },
    ]);
    expect((await c.listComments('123456')).items).toEqual([
      {
        id: '5',
        storage: '<p>hi</p>',
        author: { username: 'jsmith' },
        created: '2026-09-02T10:00:00.000+0300',
        version: 1,
      },
    ]);
    expect(fetch.calls[0]?.url.searchParams.get('location')).toBe('footer');
    await c.createComment('123456', '<p>new</p>');
    expect(JSON.parse(fetch.calls[1]?.bodyText ?? '')).toEqual({
      type: 'comment',
      container: { id: '123456', type: 'page' },
      body: { storage: { value: '<p>new</p>', representation: 'storage' } },
    });
    expect((await c.getComment('6')).type).toBe('comment');
    await c.deleteComment('6');
    expect(fetch.calls[3]?.method).toBe('DELETE');
  });

  it('lists attachments and downloads through _links.download with the suffix knob and MIME fallback', async () => {
    const routes: Route[] = [
      {
        path: '/rest/api/content/123456/child/attachment',
        json: {
          results: [
            {
              id: '9',
              type: 'attachment',
              title: 'shot.png',
              metadata: { mediaType: 'image/png' },
              extensions: { fileSize: 3 },
              version: { number: 2 },
              _links: { download: '/download/attachments/123456/shot.png?version=2' },
            },
          ],
          size: 1,
        },
      },
      {
        path: '/download/attachments/123456/shot.png',
        bytes: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream' },
      },
    ];
    const { c, fetch } = client(routes, 'download=true');
    const [att] = (await c.listAttachments('123456')).items;
    expect(att).toEqual({
      id: '9',
      filename: 'shot.png',
      mediaType: 'image/png',
      size: 3,
      downloadPath: '/download/attachments/123456/shot.png?version=2',
      version: 2,
    });
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const result = await c.downloadAttachment(att!, sink, { maxBytes: 10 });
    expect(result).toEqual({ status: 'saved', bytes: 3, mimeType: 'image/png' });
    expect(fetch.calls[1]?.url.search).toBe('?version=2&download=true');
    expect(
      await c.downloadAttachment({ ...att!, size: 99 }, new PassThrough(), { maxBytes: 10 })
    ).toEqual({ status: 'skipped', reason: 'size', size: 99, maxBytes: 10 });
  });

  it('rejects an HTML page served instead of an attachment, naming the config knob', async () => {
    const { c } = client([
      {
        path: '/download/attachments/1/f.pdf',
        text: '<html>login</html>',
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      },
    ]);
    await expect(
      c.downloadAttachment(
        {
          id: '1',
          filename: 'f.pdf',
          mediaType: 'application/pdf',
          size: 1,
          downloadPath: '/download/attachments/1/f.pdf',
        },
        new PassThrough(),
        { maxBytes: 100 }
      )
    ).rejects.toMatchObject({ code: 'http', hint: expect.stringContaining('downloadUrlSuffix') });
  });

  it('converts bodies and surfaces the server parse error through the contract', async () => {
    const { c, fetch } = client([
      {
        method: 'POST',
        path: '/rest/api/contentbody/convert/view',
        handler: (call) =>
          (JSON.parse(call.bodyText ?? '{}') as { value: string }).value.includes('<bad')
            ? {
                status: 400,
                json: {
                  statusCode: 400,
                  message: 'Error parsing xhtml: Unexpected close tag',
                  data: { errors: [] },
                },
              }
            : { json: { value: '<p>ok</p>', representation: 'view' } },
      },
    ]);
    expect(await c.convertBody('<p>ok</p>')).toBe('<p>ok</p>');
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '')).toEqual({
      value: '<p>ok</p>',
      representation: 'storage',
    });
    await expect(c.convertBody('<bad>')).rejects.toMatchObject({
      code: 'validation',
      http: 400,
      message: 'Error parsing xhtml: Unexpected close tag',
      request: { method: 'POST', url: '/rest/api/contentbody/convert/view' },
    });
  });

  it('keeps a directory user with no key, which is writable in username mode', async () => {
    // "Keyless" is not "unknown": a page whose inferred convention is `ri:username` never needs the
    // key, so validation keeps the user and the writer refuses the key-mode write instead.
    const { c } = client([
      {
        path: '/rest/api/user',
        json: { type: 'known', username: 'nokey', userKey: '' },
      },
    ]);
    const result = await c.validateMentions(['nokey']);
    expect([...result.known.entries()]).toEqual([['nokey', '']]);
    expect(result.unknown).toEqual([]);
  });

  it('remembers a user that does not exist instead of asking again', async () => {
    // The negative entry is `null`, and a truthy check never saw it, so every lookup of the same
    // missing name went back to the server.
    const { c, fetch } = client([
      { path: '/rest/api/user', status: 404, json: { statusCode: 404, message: 'No user found' } },
    ]);
    // validateMentions is what records the negative; getUser is what kept ignoring it.
    expect((await c.validateMentions(['ghost'])).unknown).toEqual(['ghost']);
    const calls = fetch.calls.length;
    await expect(c.getUser('ghost')).rejects.toMatchObject({ code: 'not_found' });
    expect(fetch.calls).toHaveLength(calls);
  });

  it('validates mentions and resolves user keys with caches', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/user',
        handler: (call) => {
          const username = call.url.searchParams.get('username');
          const key = call.url.searchParams.get('key');
          if (username === 'jsmith' || key === 'k1')
            return { json: { type: 'known', username: 'jsmith', userKey: 'k1' } };
          if (username === 'jdoe' || key === 'k2')
            return { json: { type: 'known', username: 'jdoe', userKey: 'k2' } };
          return { status: 404, json: { statusCode: 404, message: 'No user found' } };
        },
      },
    ]);
    const result = await c.validateMentions(['jsmith', 'ghost', 'jsmith']);
    expect([...result.known.entries()]).toEqual([['jsmith', 'k1']]);
    expect(result.unknown).toEqual(['ghost']);
    const calls = fetch.calls.length;
    await c.validateMentions(['jsmith', 'ghost']);
    expect(fetch.calls).toHaveLength(calls);
    const dir = await c.resolveUserKeys(['k1', 'k2', 'k9']);
    expect(dir.usernameForKey('k1')).toBe('jsmith');
    expect(dir.usernameForKey('k2')).toBe('jdoe');
    expect(dir.usernameForKey('k9')).toBeUndefined();
    // k1 was cached from the username lookup, so only k2 and k9 hit the server.
    expect(fetch.calls.length - calls).toBe(2);
  });
});
