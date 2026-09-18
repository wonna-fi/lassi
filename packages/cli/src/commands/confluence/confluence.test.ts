import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Route } from '@wonna/lassi-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const STORAGE =
  '<h2>Overview</h2><p>Hello <strong>world</strong></p>' +
  '<ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="abc">' +
  '<ac:parameter ac:name="language">ts</ac:parameter>' +
  '<ac:plain-text-body><![CDATA[const a = 1;]]></ac:plain-text-body></ac:structured-macro>';

const PAGE = {
  id: '123456',
  type: 'page',
  title: 'Payment design',
  space: { key: 'DEV', name: 'Development' },
  version: { number: 12, when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } },
  ancestors: [{ id: '100' }, { id: '123400' }],
  body: { storage: { value: STORAGE, representation: 'storage' } },
  history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } } },
  children: {
    page: { results: [{ id: '1' }, { id: '2' }], size: 2, limit: 25, start: 0 },
    comment: { results: [{ id: '777' }], size: 1, limit: 25, start: 0 },
    attachment: { results: [{ id: '9' }, { id: '10' }], size: 2, limit: 25, start: 0 },
  },
};

const COMMENTS = {
  results: [
    {
      id: '777',
      type: 'comment',
      title: 'Re: Payment design',
      body: { storage: { value: '<p>Looks <em>good</em></p>' } },
      history: { createdBy: { username: 'jdoe' }, createdDate: '2026-09-02T08:00:00.000+0300' },
      version: { number: 1 },
    },
  ],
  start: 0,
  limit: 50,
  size: 1,
};

const ATTACHMENTS = {
  results: [
    {
      id: '9',
      type: 'attachment',
      title: 'diagram.png',
      metadata: { mediaType: 'image/png' },
      extensions: { fileSize: 3 },
      _links: { download: '/download/attachments/123456/diagram.png?version=1&api=v2' },
    },
    {
      id: '10',
      type: 'attachment',
      title: 'huge.zip',
      metadata: { mediaType: 'application/zip' },
      extensions: { fileSize: 200 * 1024 * 1024 },
      _links: { download: '/download/attachments/123456/huge.zip' },
    },
  ],
  start: 0,
  limit: 50,
  size: 2,
};

const ROUTES: Route[] = [
  { path: '/rest/api/content/123456', json: PAGE },
  { path: '/rest/api/content/123456/child/comment', json: COMMENTS },
  { path: '/rest/api/content/123456/child/attachment', json: ATTACHMENTS },
  {
    path: '/rest/api/content/123456/child/page',
    json: {
      results: [
        { id: '1', type: 'page', title: 'Child A' },
        { id: '2', type: 'page', title: 'Child B' },
      ],
      size: 2,
    },
  },
  {
    path: '/rest/api/content/1/child/page',
    json: { results: [{ id: '3', type: 'page', title: 'Grandchild' }], size: 1 },
  },
  { path: '/rest/api/content/2/child/page', json: { results: [], size: 0 } },
  { path: '/rest/api/content/3/child/page', json: { results: [], size: 0 } },
  {
    path: '/rest/api/content',
    handler: (call) =>
      call.url.searchParams.get('title') === 'Payment design' &&
      call.url.searchParams.get('spaceKey') === 'DEV'
        ? { json: { results: [PAGE], size: 1 } }
        : { json: { results: [], size: 0 } },
  },
  {
    path: '/rest/api/content/search',
    handler: (call) =>
      call.url.searchParams.get('cql')?.includes('nothing')
        ? { json: { results: [], start: 0, limit: 50, size: 0, totalSize: 0 } }
        : {
            json: {
              results: [
                {
                  id: '123456',
                  type: 'page',
                  title: 'Payment design',
                  space: { key: 'DEV' },
                  history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300' } },
                },
              ],
              start: 0,
              limit: 50,
              size: 1,
              totalSize: 1,
            },
          },
  },
  {
    path: '/rest/api/space/DEV',
    json: { key: 'DEV', homepage: { id: '123456', type: 'page', title: 'Payment design' } },
  },
  {
    method: 'POST',
    path: '/rest/api/contentbody/convert/view',
    json: {
      value:
        '<h2 id="Payment-Overview">Overview</h2><p class="auto-cursor-target">Hello <strong>world</strong></p><div class="code panel pdl conf-macro output-block" data-macro-name="code"><div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: typescript; gutter: false">const a = 1;</pre></div></div>',
    },
  },
  {
    path: '/download/attachments/123456/diagram.png',
    bytes: new Uint8Array([1, 2, 3]),
    headers: { 'content-type': 'image/png' },
  },
];

function program(files: Record<string, string> = {}, env: Record<string, string> = {}) {
  return makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV, ...env }, routes: ROUTES, files });
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const BODY = '## Overview\n\nHello **world**\n\n```ts\nconst a = 1;\n```\n';

describe('lassi confluence page get', () => {
  it('prints the page frontmatter, the storage as markdown and the counts trailer', async () => {
    const t = program();
    expect(await t.run(['confluence', 'page', 'get', '123456'])).toBe(0);
    const out = t.stdout();
    expect(
      out.startsWith('---\nid: 123456\ntitle: Payment design\nspace: DEV\nparent: 123400\n')
    ).toBe(true);
    expect(out).toContain('readonly:\n  version: 12\n');
    expect(out).toContain('lastModifiedBy: jdoe\n');
    expect(out).toContain(
      '  url: https://confluence.example.internal/pages/viewpage.action?pageId=123456\n'
    );
    expect(out).toContain('counts: { children: 2, comments: 1, attachments: 2 }\n');
    expect(out).toMatch(
      /lassi: \{ fetchedAt: '?2026-09-04T10:00:00\.000Z'?, product: confluence, schema: 1, storageSha256: [0-9a-f]{64}, format: md \}\n/
    );
    expect(out).toContain(`\n---\n\n${BODY}`);
    expect(
      out
        .trimEnd()
        .endsWith(
          '(1 comment, 2 attachments, 2 child pages not shown — use --comments, --attachments, `lassi confluence tree <ID>`)'
        )
    ).toBe(true);
    // Every request went to the Confluence instance with its own token, never the Jira one.
    for (const call of t.fetch.calls) {
      expect(call.url.origin).toBe('https://confluence.example.internal');
      expect(call.headers.authorization).toBe('Bearer confluence-secret-token');
    }
  });

  it('resolves SPACE:Title references and a bare title through confluence.defaultSpace', async () => {
    const byTitle = program();
    expect(await byTitle.run(['confluence', 'page', 'get', 'DEV:Payment design'])).toBe(0);
    expect(byTitle.stdout()).toContain('title: Payment design\n');

    const bare = program({
      '/home/u/proj/.lassi.json': JSON.stringify({ confluence: { defaultSpace: 'DEV' } }),
    });
    expect(await bare.run(['confluence', 'page', 'get', 'Payment design'])).toBe(0);
    expect(bare.stdout()).toContain('id: 123456\n');

    const missing = program();
    expect(await missing.run(['confluence', 'page', 'get', 'DEV:Nope'])).toBe(4);
    expect(missing.stdout()).toBe('');
    expect(lastJsonLine(missing.stderr())).toMatchObject({ code: 'not_found' });
  });

  it('includes comments and attachments sections on request and reports what is hidden', async () => {
    const t = program();
    expect(
      await t.run(['confluence', 'page', 'get', '123456', '--comments', '--attachments'])
    ).toBe(0);
    const out = t.stdout();
    expect(out).toContain(
      `${BODY}\n## Comments\n\n### jdoe · 2026-09-02T08:00:00.000+0300 · id 777\n\nLooks *good*\n`
    );
    expect(out).toContain(
      '## Attachments\n\n| File | Size | MIME | Id |\n| - | - | - | - |\n| diagram.png | 3 B | image/png | 9 |\n| huge.zip | 200.0 MB | application/zip | 10 |\n'
    );
    expect(out).toContain('(2 child pages not shown — use `lassi confluence tree <ID>`)');
    expect(out).not.toContain('comment not shown');
  });

  it('--out writes the working file, the exact storage cache, the sidecar and drops older versions', async () => {
    const t = program({
      '/home/u/proj/.lassi/cache/confluence/123456.v11.xml': '<p>old</p>',
      '/home/u/proj/.lassi/cache/confluence/999.v3.xml': '<p>other page</p>',
    });
    expect(
      await t.run(['confluence', 'page', 'get', '123456', '--out', 'work/page.md', '--comments'])
    ).toBe(0);
    expect(t.stdout()).toBe(
      'wrote work/page.md (cache: .lassi/cache/confluence/123456.v12.xml)\n(2 attachments, 2 child pages not shown — use --attachments, `lassi confluence tree <ID>`)\n'
    );
    const file = await t.fs.readFile('/home/u/proj/work/page.md');
    expect(file).toContain('title: Payment design\n');
    expect(file).toContain(`${BODY}\n## Comments\n`);
    expect(await t.fs.readFile('/home/u/proj/.lassi/cache/confluence/123456.v12.xml')).toBe(
      STORAGE
    );
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v11.xml')).toBe(false);
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/999.v3.xml')).toBe(true);
    const sidecar = JSON.parse(
      await t.fs.readFile('/home/u/proj/.lassi/cache/confluence/123456.json')
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      schema: 1,
      id: '123456',
      version: 12,
      format: 'md',
      fetchedAt: '2026-09-04T10:00:00.000Z',
    });
    expect(sidecar.sections).toContain('## Comments');
    expect(sidecar.storageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--format storage prints the raw XHTML and writes it without a cache under --out', async () => {
    const t = program();
    expect(await t.run(['confluence', 'page', 'get', '123456', '--format', 'storage'])).toBe(0);
    expect(t.stdout()).toBe(`${STORAGE}\n`);

    const out = program();
    expect(
      await out.run([
        'confluence',
        'page',
        'get',
        '123456',
        '--format',
        'storage',
        '--out',
        'p.xml',
      ])
    ).toBe(0);
    expect(await out.fs.readFile('/home/u/proj/p.xml')).toBe(STORAGE);
    expect(await out.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v12.xml')).toBe(false);

    // The raw storage body has no frontmatter, so validate and update both reject it. The next step
    // used to tell an agent to run exactly those two, and named an absolute path while doing it.
    const axi = program();
    await axi.run([
      'confluence',
      'page',
      'get',
      '123456',
      '--format',
      'storage',
      '--out',
      'p.xml',
      '--axi',
    ]);
    expect(axi.stdout()).toContain('path: p.xml');
    expect(axi.stdout()).toContain('cannot be updated: it is read-only');
    expect(axi.stdout()).not.toContain('page update');

    // The view format writes a working file but no storage cache, so it is read-only too and the
    // payload says so with `cache: null` rather than by omitting the key.
    const view = program();
    await view.run([
      'confluence',
      'page',
      'get',
      '123456',
      '--format',
      'view',
      '--out',
      'work/view.md',
      '--axi',
    ]);
    expect(view.stdout()).toContain('cannot be updated: it is read-only');
    expect(view.stdout()).not.toContain('page update');

    const bad = program();
    expect(await bad.run(['confluence', 'page', 'get', '123456', '--format', 'pdf'])).toBe(2);
    expect(lastJsonLine(bad.stderr())).toMatchObject({ code: 'usage' });
  });

  it('--format view renders the server view as read-only markdown without a storage cache', async () => {
    const t = program();
    expect(
      await t.run([
        'confluence',
        'page',
        'get',
        '123456',
        '--format',
        'view',
        '--out',
        'work/view.md',
      ])
    ).toBe(0);
    expect(t.stdout()).toContain('wrote work/view.md (view format: read-only, no storage cache)');
    const file = await t.fs.readFile('/home/u/proj/work/view.md');
    expect(file).toContain('format: view }');
    expect(file).toContain(`\n---\n\n${BODY.replace('```ts', '```typescript')}`);
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v12.xml')).toBe(false);
    const sidecar = JSON.parse(
      await t.fs.readFile('/home/u/proj/.lassi/cache/confluence/123456.json')
    ) as { format: string };
    expect(sidecar.format).toBe('view');
    const convert = t.fetch.calls.find(
      (c) => c.url.pathname === '/rest/api/contentbody/convert/view'
    );
    expect(convert?.method).toBe('POST');
    expect(JSON.parse(convert?.bodyText ?? '')).toEqual({
      value: STORAGE,
      representation: 'storage',
    });
  });

  it('--json emits one document with frontmatter and body, and reads work under LASSI_READ_ONLY', async () => {
    const t = program({}, { LASSI_READ_ONLY: '1' });
    expect(await t.run(['confluence', 'page', 'get', '123456', '--json'])).toBe(0);
    const doc = JSON.parse(t.stdout()) as {
      frontmatter: { id: number; counts: unknown };
      body: string;
    };
    expect(doc.frontmatter.id).toBe(123456);
    expect(doc.frontmatter.counts).toEqual({ children: 2, comments: 1, attachments: 2 });
    expect(doc.body).toBe(BODY);
  });
});

describe('lassi confluence search and tree', () => {
  it('search renders the result table and a definitive empty state', async () => {
    const t = program();
    expect(await t.run(['confluence', 'search', 'space = DEV and type = page'])).toBe(0);
    expect(t.stdout()).toContain('| Id | Type | Space | Title | Updated |');
    expect(t.stdout()).toContain(
      '| 123456 | page | DEV | Payment design | 2026-09-01T12:00:00.000+0300 |'
    );
    expect(t.fetch.calls[0]?.url.searchParams.get('cql')).toBe('space = DEV and type = page');
    expect(t.fetch.calls[0]?.url.searchParams.get('limit')).toBe('50');

    const empty = program();
    expect(await empty.run(['confluence', 'search', 'title ~ nothing', '--json'])).toBe(0);
    expect(JSON.parse(empty.stdout())).toEqual({ total: 0, results: [] });
    const md = program();
    await md.run(['confluence', 'search', 'title ~ nothing']);
    expect(md.stdout()).toBe('no results for title ~ nothing\n');

    const bad = program();
    expect(await bad.run(['confluence', 'search', 'x', '--limit', 'many'])).toBe(2);
  });

  it('tree lists the hierarchy below a page or a space homepage to the requested depth', async () => {
    const t = program();
    expect(await t.run(['confluence', 'tree', '123456'])).toBe(0);
    expect(t.stdout()).toBe(
      '- Payment design (123456)\n  - Child A (1)\n    - Grandchild (3)\n  - Child B (2)\n'
    );
    const shallow = program();
    await shallow.run(['confluence', 'tree', 'DEV', '--depth', '1']);
    expect(shallow.stdout()).toBe('- Payment design (123456)\n  - Child A (1)\n  - Child B (2)\n');
    expect(shallow.fetch.calls[0]?.url.pathname).toBe('/rest/api/space/DEV');
    const json = program();
    await json.run(['confluence', 'tree', '123456', '--depth', '1', '--json']);
    expect(JSON.parse(json.stdout())).toMatchObject({ truncated: [], root: { id: '123456' } });
  });
});

describe('lassi confluence comment list and attach get', () => {
  it('comment list renders every footer comment as markdown', async () => {
    const t = program();
    expect(await t.run(['confluence', 'comment', 'list', '123456'])).toBe(0);
    expect(t.stdout()).toBe('### jdoe · 2026-09-02T08:00:00.000+0300 · id 777\n\nLooks *good*\n');
    const call = t.fetch.calls[0];
    expect(call?.url.pathname).toBe('/rest/api/content/123456/child/comment');
    expect(call?.url.searchParams.get('location')).toBe('footer');
    expect(call?.url.searchParams.get('expand')).toContain('body.storage');
  });

  it('attach get downloads matching files, skips oversized ones and reports paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-conf-attach-'));
    tmpDirs.push(dir);
    const t = program();
    expect(await t.run(['confluence', 'attach', 'get', '123456', '--out', dir])).toBe(0);
    expect(await readFile(join(dir, 'diagram.png'))).toEqual(Buffer.from([1, 2, 3]));
    expect(t.stdout()).toContain('| File | Path | Bytes | MIME | Status |');
    expect(t.stdout()).toContain('| diagram.png |');
    expect(t.stdout()).toContain('| 3 | image/png | saved |');
    expect(t.stdout()).toMatch(/\| huge\.zip \|  \| 209715200 \| application\/zip \| skipped/);
    const download = t.fetch.calls.find((c) => c.url.pathname.endsWith('/diagram.png'));
    expect(download?.url.search).toBe('?version=1&api=v2');

    const only = program();
    await only.run([
      'confluence',
      'attach',
      'get',
      '123456',
      '--out',
      dir,
      '--only',
      '*.zip',
      '--max-size',
      '1000',
    ]);
    expect(only.stdout()).not.toContain('diagram.png');
    expect(only.stdout()).toContain('| huge.zip |');

    const none = program();
    await none.run(['confluence', 'attach', 'get', '123456', '--out', dir, '--only', '*.pdf']);
    expect(none.stdout()).toBe('no attachments matching *.pdf on page 123456\n');
  });
});
