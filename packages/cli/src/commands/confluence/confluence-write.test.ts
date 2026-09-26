import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const STORAGE = '<h2>Overview</h2><p>Hello <strong>world</strong></p>';

function pageFixture(version: number, storage: string) {
  return {
    id: '123456',
    type: 'page',
    title: 'Payment design',
    space: { key: 'DEV', name: 'Development' },
    version: { number: version, when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } },
    ancestors: [{ id: '100' }, { id: '123400' }],
    body: { storage: { value: storage, representation: 'storage' } },
    history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } } },
    children: {
      page: { results: [], size: 0, limit: 25, start: 0 },
      comment: { results: [{ id: '777' }], size: 1, limit: 25, start: 0 },
      attachment: { results: [], size: 0, limit: 25, start: 0 },
    },
  };
}

const COMMENTS = {
  results: [
    {
      id: '777',
      type: 'comment',
      body: { storage: { value: '<p>Looks <em>good</em></p>' } },
      history: { createdBy: { username: 'jsmith' }, createdDate: '2026-09-02T08:00:00.000+0300' },
      version: { number: 1 },
    },
  ],
  size: 1,
  limit: 50,
};

interface Server {
  page: ReturnType<typeof pageFixture>;
  puts: unknown[];
  posts: unknown[];
  deletes: string[];
}

/** A tiny stateful fake: PUT bumps the version and stores the body, GET returns the current page. */
function server(initial = pageFixture(12, STORAGE)): { routes: Route[]; state: Server } {
  const state: Server = { page: initial, puts: [], posts: [], deletes: [] };
  const routes: Route[] = [
    { path: '/rest/api/user/current', json: { type: 'known', username: 'jsmith', userKey: 'k0' } },
    {
      path: '/rest/api/user',
      handler: (call) => {
        const username = call.url.searchParams.get('username');
        return username === 'jsmith' || username === 'jdoe'
          ? { json: { type: 'known', username, userKey: `key-${username}` } }
          : { status: 404, json: { statusCode: 404, message: 'No user found' } };
      },
    },
    { method: 'GET', path: '/rest/api/content/123456', handler: () => ({ json: state.page }) },
    { path: '/rest/api/content/123456/child/comment', json: COMMENTS },
    { path: '/rest/api/content/123456/child/attachment', json: { results: [], size: 0 } },
    {
      method: 'PUT',
      path: '/rest/api/content/123456',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as {
          title: string;
          version: { number: number };
          body?: { storage: { value: string } };
        };
        state.puts.push(body);
        state.page = {
          ...state.page,
          title: body.title,
          version: { ...state.page.version, number: body.version.number },
          body: {
            storage: {
              value: body.body?.storage.value ?? state.page.body.storage.value,
              representation: 'storage',
            },
          },
        };
        return { json: state.page };
      },
    },
    {
      method: 'POST',
      path: '/rest/api/content',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as { type: string };
        state.posts.push(body);
        return { json: { id: body.type === 'comment' ? '778' : '900', type: body.type } };
      },
    },
    {
      method: 'GET',
      path: '/rest/api/content/777',
      json: {
        id: '777',
        type: 'comment',
        history: { createdBy: { username: 'jsmith' }, createdDate: '2026-09-02T08:00:00.000+0300' },
      },
    },
    {
      method: 'GET',
      path: '/rest/api/content/778',
      json: {
        id: '778',
        type: 'comment',
        history: { createdBy: { username: 'jdoe' }, createdDate: '2026-09-02T09:00:00.000+0300' },
      },
    },
    {
      method: 'DELETE',
      path: '/rest/api/content/777',
      handler: () => {
        state.deletes.push('777');
        return { status: 204, text: '' };
      },
    },
    {
      method: 'DELETE',
      path: '/rest/api/content/778',
      handler: () => {
        state.deletes.push('778');
        return { status: 204, text: '' };
      },
    },
    {
      method: 'POST',
      path: '/rest/api/contentbody/convert/view',
      handler: (call) => {
        const { value } = JSON.parse(call.bodyText ?? '{}') as { value: string };
        return value.includes('<bad>')
          ? {
              status: 400,
              json: {
                statusCode: 400,
                message: 'Error parsing xhtml: Unexpected close tag </p>; expected </bad>.',
              },
            }
          : { json: { value: '<p>ok</p>', representation: 'view' } };
      },
    },
  ];
  return { routes, state };
}

function program(
  routes: Route[],
  extra: { files?: Record<string, string>; env?: Record<string, string>; stdin?: string } = {}
) {
  return makeTestProgram({
    env: { ...BOTH_PRODUCTS_ENV, ...extra.env },
    routes,
    files: extra.files ?? {},
    ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
  });
}

function mutating(t: ReturnType<typeof program>) {
  return t.fetch.calls.filter((c) => c.method !== 'GET');
}

describe('lassi confluence page create', () => {
  it('converts the body, resolves mentions to user keys and posts the page', async () => {
    const { routes, state } = server();
    const t = program(routes);
    expect(
      await t.run([
        'confluence',
        'page',
        'create',
        '--space',
        'DEV',
        '--title',
        'New page',
        '--parent',
        '123456',
        '--body',
        '# Hi\n\nAsk @jsmith.\n',
      ])
    ).toBe(0);
    expect(state.posts).toEqual([
      {
        type: 'page',
        title: 'New page',
        space: { key: 'DEV' },
        ancestors: [{ id: '123456' }],
        body: {
          storage: {
            value: '<h1>Hi</h1><p>Ask <ac:link><ri:user ri:userkey="key-jsmith" /></ac:link>.</p>',
            representation: 'storage',
          },
        },
      },
    ]);
    expect(t.stdout()).toBe(
      'created page 900 https://confluence.example.internal/pages/viewpage.action?pageId=900\n'
    );
  });

  it('takes title, space and parent from the file frontmatter and stdin as the body', async () => {
    const { routes, state } = server();
    const t = program(routes, {
      files: {
        '/home/u/proj/new.md': '---\ntitle: From file\nspace: DEV\nparent: 100\n---\n\nBody.\n',
      },
    });
    expect(await t.run(['confluence', 'page', 'create', '--file', 'new.md'])).toBe(0);
    expect(state.posts[0]).toMatchObject({
      title: 'From file',
      space: { key: 'DEV' },
      ancestors: [{ id: '100' }],
      body: { storage: { value: '<p>Body.</p>' } },
    });
    const piped = program(routes, { stdin: 'Piped.\n' });
    expect(
      await piped.run(['confluence', 'page', 'create', '--space', 'DEV', '--title', 'T'])
    ).toBe(0);
    expect(state.posts[1]).toMatchObject({ body: { storage: { value: '<p>Piped.</p>' } } });
    const missing = program(routes);
    expect(await missing.run(['confluence', 'page', 'create', '--body', 'x'])).toBe(2);
    expect(lastJsonLine(missing.stderr())).toMatchObject({ code: 'usage' });
  });

  it('--dry-run prints the storage and sends nothing; --json gives the preview as data', async () => {
    const { routes } = server();
    const t = program(routes);
    expect(
      await t.run([
        'confluence',
        'page',
        'create',
        '--space',
        'DEV',
        '--title',
        'T',
        '--body',
        'Hi @jdoe',
        '--dry-run',
      ])
    ).toBe(0);
    expect(t.stdout()).toContain('DRY RUN — nothing sent');
    expect(t.stdout()).toContain('POST /rest/api/content');
    expect(t.stdout()).toContain('--- body (storage) ---');
    expect(t.stdout()).toContain('<p>Hi <ac:link><ri:user ri:userkey="key-jdoe" /></ac:link></p>');
    expect(t.stdout()).toContain('title "T" in space DEV');
    expect(mutating(t)).toHaveLength(0);
    // The mention lookup is a read and makes the preview honest.
    expect(t.fetch.calls.some((c) => c.url.pathname === '/rest/api/user')).toBe(true);

    const json = program(routes);
    await json.run([
      'confluence',
      'page',
      'create',
      '--space',
      'DEV',
      '--title',
      'T',
      '--body',
      'x',
      '--dry-run',
      '--json',
    ]);
    expect(JSON.parse(json.stdout())).toMatchObject({
      dryRun: true,
      method: 'POST',
      path: '/rest/api/content',
    });
  });

  it('refuses pasted storage (exit 2), unknown mentions (exit 5) and read-only mode (exit 7)', async () => {
    const { routes } = server();
    const leak = program(routes);
    expect(
      await leak.run([
        'confluence',
        'page',
        'create',
        '--space',
        'DEV',
        '--title',
        'T',
        '--body',
        'x <ac:structured-macro ac:name="toc" /> y',
      ])
    ).toBe(2);
    expect(lastJsonLine(leak.stderr())).toMatchObject({
      code: 'usage',
      hint: expect.stringContaining('```confluence'),
    });
    expect(mutating(leak)).toHaveLength(0);

    const ghost = program(routes);
    expect(
      await ghost.run([
        'confluence',
        'page',
        'create',
        '--space',
        'DEV',
        '--title',
        'T',
        '--body',
        'Hi @ghost',
      ])
    ).toBe(5);
    expect(lastJsonLine(ghost.stderr())).toMatchObject({
      code: 'validation',
      message: 'unknown user: @ghost',
    });
    expect(mutating(ghost)).toHaveLength(0);

    const ro = program(routes, { env: { LASSI_READ_ONLY: '1' } });
    expect(
      await ro.run([
        'confluence',
        'page',
        'create',
        '--space',
        'DEV',
        '--title',
        'T',
        '--body',
        'x',
      ])
    ).toBe(7);
    expect(ro.fetch.calls).toHaveLength(0);
  });
});

describe('lassi confluence page validate', () => {
  it('lets the server parse the converted storage and renders its 400 through the contract', async () => {
    const { routes } = server();
    const ok = program(routes, { files: { '/home/u/proj/p.md': '# Fine\n\nText.\n' } });
    expect(await ok.run(['confluence', 'page', 'validate', '--file', 'p.md'])).toBe(0);
    expect(ok.stdout()).toBe('valid: the server accepted 25 bytes of storage\n');
    const convert = ok.fetch.calls.find((c) => c.url.pathname.endsWith('/convert/view'));
    expect(JSON.parse(convert?.bodyText ?? '{}')).toEqual({
      value: '<h1>Fine</h1><p>Text.</p>',
      representation: 'storage',
    });

    const bad = program(routes, {
      files: { '/home/u/proj/bad.md': 'Text.\n\n```confluence\n<p><bad></p>\n```\n' },
    });
    expect(await bad.run(['confluence', 'page', 'validate', '--file', 'bad.md'])).toBe(5);
    expect(bad.stdout()).toBe('');
    expect(bad.stderr()).toContain(
      'error: Confluence rejected the request (400): Error parsing xhtml'
    );
    expect(lastJsonLine(bad.stderr())).toMatchObject({
      code: 'validation',
      http: 400,
      message: expect.stringContaining('Error parsing xhtml'),
      request: { method: 'POST', url: '/rest/api/contentbody/convert/view' },
    });
  });
});

describe('lassi confluence page update', () => {
  async function fetched(routes: Route[], extra: Parameters<typeof program>[1] = {}) {
    const t = program(routes, extra);
    expect(
      await t.run(['confluence', 'page', 'get', '123456', '--out', 'work/page.md', '--comments'])
    ).toBe(0);
    const file = await t.fs.readFile('/home/u/proj/work/page.md');
    return { t, file };
  }

  it('sends the edited body as storage with version+1, then re-fetches and rotates the cache', async () => {
    const { routes, state } = server();
    const { t, file } = await fetched(routes);
    await t.fs.writeFile(
      '/home/u/proj/work/page.md',
      file.replace('Hello **world**\n', 'Hello **world**\n\nAdded line with @jdoe.\n')
    );
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(0);
    expect(state.puts).toEqual([
      {
        id: '123456',
        type: 'page',
        title: 'Payment design',
        version: { number: 13 },
        body: {
          storage: {
            value:
              '<h2>Overview</h2><p>Hello <strong>world</strong></p><p>Added line with <ac:link><ri:user ri:userkey="key-jdoe" /></ac:link>.</p>',
            representation: 'storage',
          },
        },
      },
    ]);
    expect(t.stdout()).toContain(
      'updated page 123456 to version 13 (body); rewrote work/page.md\n'
    );
    const rewritten = await t.fs.readFile('/home/u/proj/work/page.md');
    expect(rewritten).toContain('version: 13\n');
    expect(rewritten).toContain('Added line with @jdoe.');
    expect(rewritten).toContain('## Comments');
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v13.xml')).toBe(true);
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v12.xml')).toBe(false);
    const sidecar = JSON.parse(
      await t.fs.readFile('/home/u/proj/.lassi/cache/confluence/123456.json')
    ) as { version: number };
    expect(sidecar.version).toBe(13);
  });

  it('changes the title from the frontmatter, reports no changes, and --dry-run sends nothing', async () => {
    const { routes, state } = server();
    const { t, file } = await fetched(routes);
    await t.fs.writeFile(
      '/home/u/proj/work/page.md',
      file.replace('title: Payment design', 'title: Payment design v2')
    );
    expect(
      await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--dry-run'])
    ).toBe(0);
    expect(t.stdout()).toContain('PUT /rest/api/content/123456');
    expect(t.stdout()).toContain('title "Payment design v2", version 12 → 13');
    expect(state.puts).toHaveLength(0);
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--keep'])).toBe(
      0
    );
    expect(state.puts).toEqual([
      { id: '123456', type: 'page', title: 'Payment design v2', version: { number: 13 } },
    ]);
    expect(t.stdout()).toContain('updated page 123456 to version 13 (title)\n');

    const same = await fetched(routes);
    expect(await same.t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(0);
    expect(same.t.stdout()).toContain('no changes for page 123456\n');
    expect(state.puts).toHaveLength(1);
  });

  it('exits 6 with the versions when the page changed on the server', async () => {
    const { routes, state } = server();
    const { t } = await fetched(routes);
    state.page = { ...state.page, version: { ...state.page.version, number: 14 } };
    expect(
      await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--title', 'X'])
    ).toBe(6);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('version 12 → 14'),
      hint: expect.stringContaining(
        '(v12 → v14); run `lassi confluence page get 123456 --out work/page.md`'
      ),
    });
    expect(state.puts).toHaveLength(0);
  });

  it('refuses a page the dialect cannot preserve unless --force, listing the differing nodes', async () => {
    const { routes, state } = server(pageFixture(12, '<p><b>legacy</b> bold</p><p>Second.</p>'));
    const { t, file } = await fetched(routes);
    await t.fs.writeFile('/home/u/proj/work/page.md', file.replace('Second.', 'Second, edited.'));
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      errorMessages: [expect.stringContaining('/p[1]/b[1]')],
      hint: expect.stringContaining('--force'),
    });
    expect(state.puts).toHaveLength(0);

    expect(
      await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--force', '--keep'])
    ).toBe(0);
    expect(state.puts).toHaveLength(1);
    expect((state.puts[0] as { body: { storage: { value: string } } }).body.storage.value).toBe(
      '<p><strong>legacy</strong> bold</p><p>Second, edited.</p>'
    );
    expect(t.stderr()).toContain('--force given');
  });

  it('strips the sections this file was fetched with, not those of a later fetch', async () => {
    const { routes, state } = server();
    const t = program(routes);
    // Two working files for one page: the first carries the comments section, the second does not.
    expect(
      await t.run(['confluence', 'page', 'get', '123456', '--out', 'a.md', '--comments'])
    ).toBe(0);
    expect(await t.run(['confluence', 'page', 'get', '123456', '--out', 'b.md'])).toBe(0);
    const a = await t.fs.readFile('/home/u/proj/a.md');
    expect(a).toContain('## Comments');
    await t.fs.writeFile(
      '/home/u/proj/a.md',
      a.replace('Hello **world**', 'Hello **world**, edited')
    );
    expect(await t.run(['confluence', 'page', 'update', '--file', 'a.md', '--keep'])).toBe(0);
    const sent = (state.puts[0] as { body: { storage: { value: string } } }).body.storage.value;
    expect(sent).toBe('<h2>Overview</h2><p>Hello <strong>world</strong>, edited</p>');
    expect(sent).not.toContain('Comments');
  });

  it('refuses a file it has no record of instead of guessing what is generated', async () => {
    const { routes, state } = server();
    const { t, file } = await fetched(routes);
    await t.fs.writeFile('/home/u/proj/work/copy.md', file);
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/copy.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('no record of work/copy.md'),
      hint: expect.stringContaining('lassi confluence page get 123456 --out work/copy.md'),
    });
    expect(state.puts).toHaveLength(0);
  });

  it('takes the version from the fetch record, so editing readonly cannot bypass the check', async () => {
    const { routes, state } = server();
    const { t, file } = await fetched(routes);
    await t.fs.writeFile('/home/u/proj/work/page.md', file.replace(/readonly:\n(?:  .*\n)+/, ''));
    state.page = { ...state.page, version: { ...state.page.version, number: 14 } };
    expect(
      await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--title', 'X'])
    ).toBe(6);
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'conflict' });
    expect(state.puts).toHaveLength(0);

    const fresh = server();
    const edited = await fetched(fresh.routes);
    await edited.t.fs.writeFile(
      '/home/u/proj/work/page.md',
      edited.file.replace('version: 12', 'version: 99')
    );
    expect(await edited.t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(2);
    expect(lastJsonLine(edited.t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('declares version 99 but was fetched at version 12'),
    });
  });

  it('leaves a page someone moved on the server where it is', async () => {
    const { routes, state } = server();
    const { t, file } = await fetched(routes);
    // Someone reparents the page in the browser; a move does not bump the content version.
    state.page = { ...state.page, ancestors: [{ id: '100' }, { id: '555' }] };
    await t.fs.writeFile(
      '/home/u/proj/work/page.md',
      file.replace('Hello **world**', 'Hello **world**, edited')
    );
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--keep'])).toBe(
      0
    );
    expect(t.stdout()).toContain('updated page 123456 to version 13 (body)');
    expect(state.puts[0]).not.toHaveProperty('ancestors');
  });

  it('does not run the fidelity gate for an edit that leaves the body alone', async () => {
    const { routes, state } = server(pageFixture(12, '<p><b>legacy</b> bold</p><p>Second.</p>'));
    const { t, file } = await fetched(routes);
    await t.fs.writeFile(
      '/home/u/proj/work/page.md',
      file.replace('title: Payment design', 'title: Payment design v2')
    );
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md', '--keep'])).toBe(
      0
    );
    expect(t.stdout()).toContain('updated page 123456 to version 13 (title)');
    expect(state.puts).toEqual([
      { id: '123456', type: 'page', title: 'Payment design v2', version: { number: 13 } },
    ]);
    expect(t.stderr()).not.toContain('fidelity');
  });

  it('refuses edited generated sections, view files, unknown keys and space moves (exit 2)', async () => {
    const { routes } = server();
    const { t, file } = await fetched(routes);
    await t.fs.writeFile('/home/u/proj/work/page.md', file.replace('Looks *good*', 'Looks *bad*'));
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('generated sections'),
    });

    await t.fs.writeFile('/home/u/proj/work/page.md', file.replace('format: md', 'format: view'));
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('--format view'),
    });

    await t.fs.writeFile(
      '/home/u/proj/work/page.md',
      file.replace('space: DEV', 'space: DEV\nlabels: [x]')
    );
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('unknown frontmatter key: labels'),
    });

    await t.fs.writeFile('/home/u/proj/work/page.md', file.replace('space: DEV', 'space: OTHER'));
    expect(await t.run(['confluence', 'page', 'update', '--file', 'work/page.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('another space'),
    });
  });

  it('updates title and parent by id without a file', async () => {
    const { routes, state } = server();
    const t = program(routes);
    expect(
      await t.run([
        'confluence',
        'page',
        'update',
        '123456',
        '--title',
        'Renamed',
        '--parent',
        '100',
      ])
    ).toBe(0);
    expect(state.puts).toEqual([
      {
        id: '123456',
        type: 'page',
        title: 'Renamed',
        version: { number: 13 },
        ancestors: [{ id: '100' }],
      },
    ]);
    const nothing = program(routes);
    expect(await nothing.run(['confluence', 'page', 'update', '123456'])).toBe(2);
  });

  it.each(['.', '..'])(
    'refuses page update %s instead of writing the content collection',
    async (id) => {
      const { routes, state } = server();
      for (const extra of [[], ['--dry-run']]) {
        const t = program(routes);
        expect(await t.run(['confluence', 'page', 'update', id, '--title', 'New', ...extra])).toBe(
          2
        );
        expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'usage' });
        expect(t.fetch.calls).toHaveLength(0);
      }
      expect(state.puts).toHaveLength(0);
    }
  );
});

describe('lassi confluence comment add and delete', () => {
  it('adds a footer comment from markdown', async () => {
    const { routes, state } = server();
    const t = program(routes);
    expect(await t.run(['confluence', 'comment', 'add', '123456', '--body', 'Looks *good*'])).toBe(
      0
    );
    expect(state.posts).toEqual([
      {
        type: 'comment',
        container: { id: '123456', type: 'page' },
        body: { storage: { value: '<p>Looks <em>good</em></p>', representation: 'storage' } },
      },
    ]);
    expect(t.stdout()).toBe('comment 778 added to page 123456\n');
    expect(
      JSON.parse(
        await (async () => {
          const j = program(routes);
          await j.run(['confluence', 'comment', 'add', '123456', '--body', 'x', '--json']);
          return j.stdout();
        })()
      )
    ).toMatchObject({
      id: '778',
      url: 'https://confluence.example.internal/pages/viewpage.action?pageId=123456&focusedCommentId=778',
    });
  });

  it('deletes own comments, needs --any for others, and never deletes a page', async () => {
    const { routes, state } = server();
    const own = program(routes);
    expect(await own.run(['confluence', 'comment', 'delete', '777'])).toBe(0);
    expect(state.deletes).toEqual(['777']);
    expect(own.stdout()).toBe('comment 777 deleted\n');

    const other = program(routes);
    expect(await other.run(['confluence', 'comment', 'delete', '778'])).toBe(5);
    expect(lastJsonLine(other.stderr())).toMatchObject({
      code: 'validation',
      message: 'comment 778 was written by jdoe, not by you (jsmith)',
    });
    expect(state.deletes).toEqual(['777']);
    const any = program(routes);
    expect(await any.run(['confluence', 'comment', 'delete', '778', '--any', '--dry-run'])).toBe(0);
    expect(any.stdout()).toContain('DELETE /rest/api/content/778');
    expect(state.deletes).toEqual(['777']);
    expect(await any.run(['confluence', 'comment', 'delete', '778', '--any'])).toBe(0);
    expect(state.deletes).toEqual(['777', '778']);

    const page = program(routes);
    expect(await page.run(['confluence', 'comment', 'delete', '123456'])).toBe(2);
    expect(lastJsonLine(page.stderr())).toMatchObject({
      message: '123456 is a page, not a comment',
    });
    expect(mutating(page)).toHaveLength(0);
  });
});
