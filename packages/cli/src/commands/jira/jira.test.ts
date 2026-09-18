import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Route } from '@wonna/lassi-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const ISSUE = {
  id: '40213',
  key: 'PROJ-123',
  fields: {
    summary: 'Login page throws 500 on empty password',
    description: 'h2. Steps\n# one\n# two\n\nSee [~jdoe].',
    issuetype: { id: '1', name: 'Bug' },
    priority: { id: '2', name: 'High' },
    status: { name: 'In Progress' },
    assignee: { name: 'jsmith', displayName: 'John Smith' },
    reporter: { name: 'jdoe', displayName: 'Jane Doe' },
    labels: ['auth', 'regression'],
    created: '2026-08-30T09:12:44.000+0300',
    updated: '2026-09-03T14:02:10.000+0300',
    comment: {
      comments: [
        {
          id: '1',
          body: 'first *comment*',
          created: '2026-09-01T10:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
        {
          id: '2',
          body: 'second',
          created: '2026-09-02T10:00:00.000+0300',
          author: { name: 'jsmith', displayName: 'S' },
        },
      ],
      total: 7,
      startAt: 0,
      maxResults: 2,
    },
    attachment: [
      {
        id: '1',
        filename: 'stack.png',
        mimeType: 'image/png',
        size: 3,
        content: 'https://jira.example.internal/secure/attachment/1/stack.png',
      },
      {
        id: '2',
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
        size: 200 * 1024 * 1024,
        content: 'https://jira.example.internal/secure/attachment/2/big.bin',
      },
    ],
    issuelinks: [
      {
        id: '9',
        type: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: {
          id: '2',
          key: 'PROJ-2',
          fields: { summary: 'Other', status: { name: 'Open' } },
        },
      },
    ],
    customfield_10001: { id: '1', value: 'Platform' },
    customfield_10005: 3,
  },
  names: { customfield_10005: 'Story Points' },
  schema: {
    customfield_10001: { type: 'option', custom: 'select' },
    customfield_10005: { type: 'number' },
  },
};

const ROUTES: Route[] = [
  { method: 'GET', path: '/rest/api/2/issue/PROJ-123', json: ISSUE },
  {
    method: 'POST',
    path: '/rest/api/2/search',
    handler: (call) => {
      const body = JSON.parse(call.bodyText ?? '{}') as { startAt: number; maxResults: number };
      const all = [1, 2, 3].map((n) => ({
        id: String(n),
        key: `PROJ-${n}`,
        fields: {
          summary: `S${n}`,
          status: { name: 'Open' },
          assignee: n === 1 ? { name: 'jsmith', displayName: 'J' } : null,
          updated: `2026-09-0${n}`,
        },
      }));
      const page = all.slice(body.startAt, body.startAt + body.maxResults);
      return {
        json: { issues: page, total: 3, startAt: body.startAt, maxResults: body.maxResults },
      };
    },
  },
  {
    path: '/rest/api/2/issue/createmeta/PROJ/issuetypes',
    json: { values: [{ id: '10001', name: 'Bug' }], total: 1 },
  },
  {
    path: '/rest/api/2/issue/createmeta/PROJ/issuetypes/10001',
    json: {
      values: [
        { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
        {
          fieldId: 'customfield_10001',
          name: 'Team',
          required: true,
          schema: { type: 'option' },
          allowedValues: [{ value: 'Platform' }, { value: 'Web' }],
        },
        {
          fieldId: 'labels',
          name: 'Labels',
          required: false,
          schema: { type: 'array', items: 'string' },
        },
      ],
      total: 3,
    },
  },
  {
    path: '/rest/api/2/issue/PROJ-123/editmeta',
    json: { fields: { summary: { name: 'Summary', required: true, schema: { type: 'string' } } } },
  },
  {
    path: '/rest/api/2/field',
    json: [
      { id: 'customfield_10001', name: 'Team', custom: true, schema: { type: 'option' } },
      { id: 'summary', name: 'Summary', custom: false },
    ],
  },
  {
    path: '/rest/api/2/issue/PROJ-123/comment',
    handler: (call) => {
      const comments = [
        ...ISSUE.fields.comment.comments,
        ...[3, 4, 5, 6, 7].map((n) => ({
          id: String(n),
          body: `comment ${n}`,
          created: `2026-09-0${n}`,
          author: { name: 'jsmith' },
        })),
      ];
      if (call.url.searchParams.get('orderBy') === '-created') comments.reverse();
      const startAt = Number(call.url.searchParams.get('startAt'));
      const maxResults = Math.min(2, Number(call.url.searchParams.get('maxResults')));
      return {
        json: {
          comments: comments.slice(startAt, startAt + maxResults),
          total: 7,
          startAt,
          maxResults,
        },
      };
    },
  },
  {
    path: '/rest/api/2/issueLinkType',
    json: {
      issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    },
  },
  {
    path: '/secure/attachment/1/stack.png',
    bytes: new Uint8Array([1, 2, 3]),
    headers: { 'content-type': 'image/png' },
  },
];

const WORKSPACE = {
  '/home/u/proj/.lassi.json': JSON.stringify({
    jira: {
      fields: { team: 'customfield_10001', ghost: 'customfield_10009' },
      defaultProject: 'PROJ',
    },
  }),
};

function program(extraRoutes: Route[] = []) {
  return makeTestProgram({
    env: BOTH_PRODUCTS_ENV,
    routes: [...extraRoutes, ...ROUTES],
    files: WORKSPACE,
  });
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('lassi jira issue get', () => {
  it('prints the issue frontmatter, the description as markdown and the counts trailer', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123'])).toBe(0);
    const out = t.stdout();
    const head =
      '---\nkey: PROJ-123\nsummary: Login page throws 500 on empty password\ntype: Bug\npriority: High\nassignee: jsmith\nlabels:\n  - auth\n  - regression\nteam: Platform\nghost: null\ncustomfield_10005: 3 # Story Points\nreadonly:\n';
    expect(out.slice(0, head.length)).toBe(head);
    expect(out).toContain('counts: { comments: 7, attachments: 2, links: 1 }');
    expect(out).toContain('\n---\n\n## Steps\n\n1. one\n2. two\n\nSee @jdoe.\n');
    expect(
      out
        .trim()
        .endsWith(
          '(7 comments, 2 attachments, 1 link not shown — use --comments, --attachments, --links or --all)'
        )
    ).toBe(true);
    expect(out).not.toContain('## Comments');
    expect(t.fetch.calls[0]?.url.search).toBe('?fields=*all&expand=names%2Cschema');
  });

  it('--all expands comments, attachments and links; --comments N keeps the newest N', async () => {
    const all = program();
    await all.run(['jira', 'issue', 'get', 'PROJ-123', '--all']);
    const out = all.stdout();
    expect(out).toContain(
      '## Comments\n\n### jdoe · 2026-09-01T10:00:00.000+0300 · id 1\n\nfirst **comment**\n\n### jsmith'
    );
    expect(out).toContain('## Attachments\n\n| File | Size | MIME | Id |');
    expect(out).toContain('| PROJ-123 blocks PROJ-2 | PROJ-2 | Other | Open |');
    expect(out).not.toContain('not shown');

    const one = program();
    await one.run(['jira', 'issue', 'get', 'PROJ-123', '--comments', '1']);
    expect(one.stdout()).toContain('### jsmith · 2026-09-07');
    expect(one.stdout()).toContain('(1 of 7 comments shown)');
    expect(one.stdout()).not.toContain('### jdoe');
    expect(one.stdout()).toContain('(2 attachments, 1 link not shown');
  });

  it('--out writes the working file with YAML comments and the cache, and prints the trailer', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md'])).toBe(0);
    const file = await t.fs.readFile('/home/u/proj/work/PROJ-123.md');
    expect(file).toContain('customfield_10005: 3 # Story Points');
    expect(file).toContain('## Steps');
    const cache = JSON.parse(
      await t.fs.readFile('/home/u/proj/.lassi/cache/jira/PROJ-123.json')
    ) as {
      editable: Record<string, unknown>;
      descriptionMarkdown: string;
      updated: string;
    };
    expect(cache.editable['team']).toBe('Platform');
    expect(cache.updated).toBe('2026-09-03T14:02:10.000+0300');
    expect(cache.descriptionMarkdown).toContain('## Steps');
    expect(t.stdout()).toBe(
      'wrote work/PROJ-123.md (cache: .lassi/cache/jira/PROJ-123.json)\n(7 comments, 2 attachments, 1 link not shown — use --comments, --attachments, --links or --all)\n'
    );
  });

  it('--json prints one document with frontmatter and body', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--json']);
    const doc = JSON.parse(t.stdout()) as {
      frontmatter: { key: string; team: string };
      body: string;
    };
    expect(doc.frontmatter.key).toBe('PROJ-123');
    expect(doc.frontmatter.team).toBe('Platform');
    expect(doc.body).toContain('## Steps');
  });

  it('reports a bad key as usage and a missing issue as not found', async () => {
    const t = program([
      {
        path: '/rest/api/2/issue/PROJ-999',
        status: 404,
        json: { errorMessages: ['Issue Does Not Exist'], errors: {} },
      },
    ]);
    expect(await t.run(['jira', 'issue', 'get', 'proj-1'])).toBe(2);
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-999'])).toBe(4);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'not_found',
      http: 404,
      message: 'Issue Does Not Exist',
      hint: expect.stringContaining('PROJ-999'),
    });
  });
});

describe('lassi jira issue search / createmeta / editmeta', () => {
  it('search renders a table and honours --limit and --all', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'search', 'project = PROJ', '--limit', '2'])).toBe(0);
    expect(t.stdout()).toBe(
      '| Key | Summary | Status | Assignee | Updated |\n| - | - | - | - | - |\n| PROJ-1 | S1 | Open | jsmith | 2026-09-01 |\n| PROJ-2 | S2 | Open |  | 2026-09-02 |\n'
    );
    expect(t.stderr()).toContain('showing 2 of 3 issues');
    expect(JSON.parse(t.fetch.calls[0]?.bodyText ?? '')).toMatchObject({
      jql: 'project = PROJ',
      maxResults: 2,
      fields: ['summary', 'status', 'assignee', 'updated'],
    });

    const all = program();
    await all.run(['jira', 'issue', 'search', 'project = PROJ', '--all', '--json']);
    expect((JSON.parse(all.stdout()) as { issues: unknown[] }).issues).toHaveLength(3);
  });

  it('createmeta shows aliases, required flags and allowed values with the detected mode', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    const out = t.stdout();
    expect(out).toContain('# PROJ createmeta (paginated)');
    expect(out).toContain('## Bug');
    expect(out).toContain('| team (Team) | customfield_10001 | yes | option | Platform, Web |');
    expect(out).toContain('| Labels | labels |  | array<string> |  |');
  });

  it('editmeta lists editable fields', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'editmeta', 'PROJ-123'])).toBe(0);
    expect(t.stdout()).toContain('| Summary | summary | yes | string |  |');
  });
});

describe('lassi jira fields / comment list / link / attach', () => {
  it('fields resolves aliases against the instance and renders the skill reference with --md', async () => {
    const t = program();
    expect(await t.run(['jira', 'fields'])).toBe(0);
    expect(t.stdout()).toContain('| team | customfield_10001 | Team | option |');
    expect(t.stdout()).toContain(
      'Unresolved aliases (not a field on this instance): ghost → customfield_10009'
    );
    const md = program();
    await md.run(['jira', 'fields', '--md']);
    expect(md.stdout().startsWith('# Jira field aliases\n')).toBe(true);
    const none = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES });
    await none.run(['jira', 'fields']);
    expect(none.stdout()).toBe('no field aliases configured (jira.fields in .lassi.json)\n');
    expect(none.fetch.calls).toHaveLength(0);
  });

  it('comment list --limit fetches the newest and notes the total', async () => {
    const t = program();
    expect(await t.run(['jira', 'comment', 'list', 'PROJ-123', '--limit', '1'])).toBe(0);
    expect(t.fetch.calls[0]?.url.search).toBe('?startAt=0&maxResults=1&orderBy=-created');
    expect(t.stdout()).toContain('### jsmith · 2026-09-07 · id 7\n\ncomment 7\n');
    expect(t.stdout().trim().endsWith('(1 of 7 comments shown)')).toBe(true);
  });

  it('link types and link list', async () => {
    const t = program();
    await t.run(['jira', 'link', 'types']);
    expect(t.stdout()).toContain('| Blocks | blocks | is blocked by |');
    const md = program();
    await md.run(['jira', 'link', 'types', '--md']);
    expect(md.stdout().startsWith('# Jira link types')).toBe(true);
    const list = program();
    await list.run(['jira', 'link', 'list', 'PROJ-123']);
    expect(list.stdout()).toContain('| PROJ-123 blocks PROJ-2 | PROJ-2 | Other | Open |');
    const json = program();
    await json.run(['jira', 'link', 'list', 'PROJ-123', '--json']);
    expect(JSON.parse(json.stdout())).toMatchObject({
      key: 'PROJ-123',
      links: [{ otherKey: 'PROJ-2' }],
    });
  });

  it('attach get downloads matching files, skips oversized ones and reports paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-attach-'));
    tmpDirs.push(dir);
    const t = program();
    expect(await t.run(['jira', 'attach', 'get', 'PROJ-123', '--out', dir])).toBe(0);
    expect(await readFile(join(dir, '1-stack.png'))).toEqual(Buffer.from([1, 2, 3]));
    expect(t.stdout()).toContain('| stack.png |');
    expect(t.stdout()).toContain('| 3 | image/png | saved |');
    expect(t.stdout()).toMatch(
      /\| big\.bin \|  \| 209715200 \| application\/octet-stream \| skipped/
    );

    const only = program();
    await only.run([
      'jira',
      'attach',
      'get',
      'PROJ-123',
      '--out',
      dir,
      '--only',
      '*.bin',
      '--max-size',
      '1000',
    ]);
    expect(only.stdout()).not.toContain('stack.png');
    expect(only.stdout()).toContain('| big.bin |');
  });
});

describe('doctor createmeta row', () => {
  it('reports the detected createmeta mode when a default project is configured', async () => {
    const t = program([
      { path: '/status', text: 'ok' },
      { path: '/rest/api/2/myself', json: { name: 'jsmith' } },
      { path: '/rest/api/user/current', json: { username: 'jsmith' } },
      { path: '/rest/api/2/serverInfo', json: { version: '9.12.0' } },
      { path: '/rest/api/settings/systemInfo', json: { version: '8.5.0' } },
    ]);
    await t.run(['doctor', '--json']);
    const rows = JSON.parse(t.stdout()) as Array<{ name: string; status: string; detail: string }>;
    expect(rows.find((r) => r.name === 'Jira createmeta')).toMatchObject({
      status: 'PASS',
      detail: 'paginated (1 issue types in PROJ)',
    });
  });
});

describe('"." as the issue key', () => {
  const HEAD = '/home/u/proj/.git/HEAD';
  function onBranch(files: Record<string, string>, workspace: Record<string, string> = WORKSPACE) {
    return makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: ROUTES,
      files: { ...workspace, ...files },
    });
  }

  it('resolves the key from .git/HEAD for a read command', async () => {
    const t = onBranch({ [HEAD]: 'ref: refs/heads/feature/proj-123-login\n' });
    expect(await t.run(['jira', 'issue', 'get', '.', '--verbose'])).toBe(0);
    expect(t.stdout()).toContain('key: PROJ-123');
    expect(t.fetch.calls[0]?.url.pathname).toBe('/rest/api/2/issue/PROJ-123');
    expect(t.stderr()).toContain('info: resolved . to PROJ-123 (branch feature/proj-123-login)');
  });

  it('follows a worktree gitdir file and prefers the default project over other keys', async () => {
    const t = onBranch({
      '/home/u/proj/.git': 'gitdir: /home/u/main/.git/worktrees/proj\n',
      '/home/u/main/.git/worktrees/proj/HEAD': 'ref: refs/heads/release/v2-1/DEV-7-and-PROJ-123\n',
    });
    expect(await t.run(['jira', 'link', 'list', '.'])).toBe(0);
    expect(t.fetch.calls[0]?.url.pathname).toBe('/rest/api/2/issue/PROJ-123');
  });

  it('uses jira.branchPattern when configured', async () => {
    const workspace = {
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { defaultProject: 'PROJ', branchPattern: '^work/([a-z]+-\\d+)' },
      }),
    };
    const t = onBranch({ [HEAD]: 'ref: refs/heads/work/proj-123-x\n' }, workspace);
    expect(await t.run(['jira', 'issue', 'editmeta', '.'])).toBe(0);
    expect(t.fetch.calls[0]?.url.pathname).toBe('/rest/api/2/issue/PROJ-123/editmeta');
    const bad = onBranch(
      { [HEAD]: 'ref: refs/heads/work/proj-123-x\n' },
      {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { branchPattern: '^work/[a-z]+-\\d+' },
        }),
      }
    );
    expect(await bad.run(['jira', 'issue', 'get', '.'])).toBe(2);
    expect(lastJsonLine(bad.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('capture group'),
    });
  });

  it('is a usage error outside a repository, on a detached HEAD, or on a branch without a key', async () => {
    const none = onBranch({});
    expect(await none.run(['jira', 'issue', 'get', '.'])).toBe(2);
    expect(lastJsonLine(none.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('not inside a git repository'),
      hint: expect.stringContaining('PROJ-123'),
    });
    expect(none.fetch.calls).toHaveLength(0);

    // A `.git` that is there and cannot be read is not "no repository": the walk stops either way,
    // and the message used to send the user looking in the wrong place.
    const locked = onBranch({ [HEAD]: 'ref: refs/heads/main\n' });
    const stat = locked.deps.fs.stat.bind(locked.deps.fs);
    locked.deps.fs.stat = async (path: string) => {
      if (path === '/home/u/proj/.git')
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return stat(path);
    };
    expect(await locked.run(['jira', 'issue', 'get', '.'])).toBe(2);
    expect(lastJsonLine(locked.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('could not be read'),
      hint: expect.stringContaining('permissions'),
    });

    const detached = onBranch({ [HEAD]: `${'a'.repeat(40)}\n` });
    expect(await detached.run(['jira', 'comment', 'list', '.'])).toBe(2);
    expect(lastJsonLine(detached.stderr())).toMatchObject({
      message: expect.stringContaining('detached'),
    });

    const main = onBranch({ [HEAD]: 'ref: refs/heads/main\n' });
    expect(await main.run(['jira', 'attach', 'get', '.'])).toBe(2);
    expect(lastJsonLine(main.stderr())).toMatchObject({
      message: 'branch "main" contains no issue key',
      hint: expect.stringContaining('jira.branchPattern'),
    });
    expect(main.fs.files.has('/home/u/proj/.lassi/./')).toBe(false);
  });

  it('still rejects anything that is neither "." nor a key', async () => {
    const t = onBranch({ [HEAD]: 'ref: refs/heads/feature/PROJ-123\n' });
    expect(await t.run(['jira', 'issue', 'get', 'proj-123'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('not a Jira issue key'),
    });
  });
});

describe('next steps after `.`', () => {
  it('name the resolved key, not the shorthand the user typed', async () => {
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: ROUTES,
      files: { '/home/u/proj/.git/HEAD': 'ref: refs/heads/feature/PROJ-123-login\n' },
    });
    expect(await t.run(['jira', 'issue', 'get', '.', '--axi'])).toBe(0);
    // A stored next step must not depend on which branch it was generated on.
    expect(t.stdout()).toContain('lassi jira comment add PROJ-123');
    expect(t.stdout()).not.toContain('comment add .');
  });
});

describe('--comments', () => {
  it('rejects a value that is not a positive number instead of showing every comment', async () => {
    // `0`, a negative and a word all used to mean "all", which is the opposite of what each says
    // and the opposite of what every sibling numeric flag does.
    for (const value of ['0', '-1', 'x', '0.5', '2.5']) {
      const t = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES });
      expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--comments', value])).toBe(2);
      expect(lastJsonLine(t.stderr())).toMatchObject({
        code: 'usage',
        message: expect.stringContaining('--comments must be a positive whole number'),
      });
      // Before the fetch: a reachable Jira should not answer a request that was never going to be
      // used, and an unreachable one should not mask the usage error with its own failure.
      expect(t.fetch.calls).toHaveLength(0);
      // `--all` overrides the value; it must not skip checking it.
      const both = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES });
      expect(
        await both.run(['jira', 'issue', 'get', 'PROJ-123', '--all', '--comments', value])
      ).toBe(2);
      expect(both.fetch.calls).toHaveLength(0);
    }
  });
});

describe('lassi jira issue changelog', () => {
  const CHANGELOG_ISSUE = {
    id: '40213',
    key: 'PROJ-123',
    fields: { summary: 'Login page throws 500 on empty password', status: { name: 'In Progress' } },
    changelog: {
      startAt: 0,
      maxResults: 2,
      total: 2,
      histories: [
        {
          id: '1',
          author: { name: 'jdoe', displayName: 'J' },
          created: '2026-09-02T09:00:00.000+0300',
          items: [
            {
              field: 'status',
              fieldtype: 'jira',
              fieldId: 'status',
              from: '1',
              fromString: 'Open',
              to: '3',
              toString: 'In Progress',
            },
          ],
        },
        {
          id: '2',
          author: { name: 'jsmith', displayName: 'S' },
          created: '2026-09-03T14:02:10.000+0300',
          items: [
            {
              field: 'Team',
              fieldtype: 'custom',
              fieldId: 'customfield_10001',
              from: null,
              fromString: null,
              to: '1',
              toString: 'Platform',
            },
          ],
        },
      ],
    },
  };
  function withChangelog(total = 2) {
    return program([
      {
        path: '/rest/api/2/issue/PROJ-123',
        handler: (call) =>
          call.url.searchParams.get('expand') === 'changelog'
            ? { json: { ...CHANGELOG_ISSUE, changelog: { ...CHANGELOG_ISSUE.changelog, total } } }
            : { json: ISSUE },
      },
    ]);
  }
  const TABLE =
    '| When | Who | Field | From | To |\n| - | - | - | - | - |\n| 2026-09-02T09:00:00.000+0300 | jdoe | status | Open | In Progress |\n| 2026-09-03T14:02:10.000+0300 | jsmith | team | - | Platform |\n';

  it('renders the history oldest first with aliases applied', async () => {
    const t = withChangelog();
    expect(await t.run(['jira', 'issue', 'changelog', 'PROJ-123'])).toBe(0);
    expect(t.stdout()).toBe(
      `# PROJ-123 changelog\n\nLogin page throws 500 on empty password (In Progress)\n\n${TABLE}`
    );
    expect(t.fetch.calls[0]?.url.search).toBe('?fields=summary%2Cstatus&expand=changelog');
    expect(t.stderr()).toBe('');
  });

  it('filters with --since (relative and exact) and --fields', async () => {
    const rel = withChangelog();
    expect(await rel.run(['jira', 'issue', 'changelog', 'PROJ-123', '--since', '1d'])).toBe(0);
    expect(rel.stdout()).toContain('| jsmith | team | - | Platform |');
    expect(rel.stdout()).not.toContain('jdoe');
    const abs = withChangelog();
    await abs.run(['jira', 'issue', 'changelog', 'PROJ-123', '--since', '2026-09-03T00:00+03:00']);
    expect(abs.stdout()).not.toContain('jdoe');
    const fields = withChangelog();
    await fields.run(['jira', 'issue', 'changelog', 'PROJ-123', '--fields', 'status']);
    expect(fields.stdout()).toContain('| jdoe | status |');
    expect(fields.stdout()).not.toContain('jsmith');
    const none = withChangelog();
    await none.run(['jira', 'issue', 'changelog', 'PROJ-123', '--since', '1h', '--fields', 'team']);
    expect(none.stdout()).toContain('no changes since 1h for team on PROJ-123\n');
    // `--fields " "` names no field, which is no filter. It used to produce an empty list, which
    // matched nothing, and printed "no changes for  on PROJ-123".
    const blank = withChangelog();
    await blank.run(['jira', 'issue', 'changelog', 'PROJ-123', '--fields', ' , ']);
    expect(blank.stdout()).toBe(
      `# PROJ-123 changelog\n\nLogin page throws 500 on empty password (In Progress)\n\n${TABLE}`
    );
  });

  it('cuts a long changed value for the table and the agent payload, never for --json', async () => {
    const long = 'x'.repeat(400);
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        {
          path: '/rest/api/2/issue/PROJ-123',
          json: {
            key: 'PROJ-123',
            fields: { summary: 'S', status: { name: 'Open' } },
            changelog: {
              total: 1,
              histories: [
                {
                  id: '1',
                  created: '2026-09-02T09:00:00.000+0300',
                  author: { name: 'jdoe', displayName: 'J D' },
                  items: [
                    { field: 'description', from: null, fromString: '', to: null, toString: long },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(await t.run(['jira', 'issue', 'changelog', 'PROJ-123'])).toBe(0);
    // An 8 KB description edit used to become a 16 KB table line, and the same again under --axi.
    expect(t.stdout()).toContain('…');
    expect(t.stdout()).not.toContain(long);
    const table = t.stdout().length;

    expect(await t.run(['jira', 'issue', 'changelog', 'PROJ-123', '--axi'])).toBe(0);
    expect(t.stdout().slice(table)).not.toContain(long);

    const full = t.stdout().length;
    expect(await t.run(['jira', 'issue', 'changelog', 'PROJ-123', '--json'])).toBe(0);
    // --json is the escape hatch for the whole value.
    expect(t.stdout().slice(full)).toContain(long);
  });

  it('warns when Jira cut the changelog, rejects a bad --since, and shapes --json and --axi', async () => {
    const cut = withChangelog(5);
    expect(await cut.run(['jira', 'issue', 'changelog', 'PROJ-123', '--json'])).toBe(0);
    expect(cut.stderr()).toContain('warn: Jira returned 2 of 5 history entries for PROJ-123');
    expect(JSON.parse(cut.stdout())).toMatchObject({
      key: 'PROJ-123',
      total: 5,
      shown: 2,
      truncated: true,
      changes: [
        expect.objectContaining({
          at: '2026-09-02T09:00:00.000+0300',
          who: 'jdoe',
          to: 'In Progress',
        }),
        expect.objectContaining({ field: 'team', from: '', to: 'Platform' }),
      ],
    });
    const bad = withChangelog();
    expect(await bad.run(['jira', 'issue', 'changelog', 'PROJ-123', '--since', 'yesterday'])).toBe(
      2
    );
    expect(lastJsonLine(bad.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('accepted: 30m, 2h, 1d, 1w'),
    });
    expect(bad.fetch.calls).toHaveLength(0);
    const axi = withChangelog();
    await axi.run(['jira', 'issue', 'changelog', 'PROJ-123', '--axi', '--since', '1d']);
    expect(axi.stdout()).toContain('shown: 1');
    expect(axi.stdout()).toContain('since: "2026-09-03T10:00:00.000Z"');
    expect(axi.stdout()).toContain('help[1]:\n  Run `lassi jira issue get PROJ-123 --comments 5`');
  });
});

describe('lassi jira templates', () => {
  const files = {
    '/home/u/proj/.lassi.json': JSON.stringify({
      jira: {
        defaultProject: 'PROJ',
        templates: {
          bug: {
            type: 'Bug',
            fields: { team: 'Platform', priority: 'High' },
            descriptionFile: 'templates/bug.md',
          },
          task: { type: 'Task', project: 'DEV', description: 'one\ntwo' },
        },
      },
    }),
    '/home/u/proj/templates/bug.md': '## Steps\n\n1.\n\n## Expected\n',
  };
  const withTemplates = (extra: Record<string, string> = files) =>
    makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES, files: extra });

  it('lists the templates as a table and one template as a skeleton to fill in', async () => {
    const list = withTemplates();
    expect(await list.run(['jira', 'templates'])).toBe(0);
    expect(list.stdout()).toBe(
      '| Template | Type | Project | Summary | Fields | Description |\n| - | - | - | - | - | - |\n| bug | Bug |  |  | team=Platform, priority=High | file templates/bug.md |\n| task | Task | DEV |  |  | inline (2 lines) |\n'
    );
    const one = withTemplates();
    expect(await one.run(['jira', 'templates', 'bug'])).toBe(0);
    expect(one.stdout()).toBe(
      [
        '# Template bug',
        '',
        '- type: Bug',
        '- project: PROJ',
        '- summary: (pass --summary)',
        '- fields: team=Platform, priority=High',
        '- create: `lassi jira issue create --template bug --summary "<summary>" [--file <md>]`',
        '',
        '## Description',
        '',
        '## Steps',
        '',
        '1.',
        '',
        '## Expected',
        '',
      ].join('\n')
    );
    expect(one.fetch.calls).toHaveLength(0);
    const json = withTemplates();
    await json.run(['jira', 'templates', 'task', '--json']);
    expect(JSON.parse(json.stdout())).toEqual({
      name: 'task',
      type: 'Task',
      project: 'DEV',
      summary: null,
      fields: {},
      description: 'one\ntwo',
    });
  });

  it('has a definitive empty state, a usage error for an unknown name, and a next step under --axi', async () => {
    const none = withTemplates(WORKSPACE);
    expect(await none.run(['jira', 'templates'])).toBe(0);
    expect(none.stdout()).toBe('no issue templates configured (jira.templates in .lassi.json)\n');
    const unknown = withTemplates();
    expect(await unknown.run(['jira', 'templates', 'story'])).toBe(2);
    expect(lastJsonLine(unknown.stderr())).toMatchObject({
      message: 'unknown template "story"; configured: bug, task',
    });
    const inherited = withTemplates();
    expect(await inherited.run(['jira', 'templates', 'toString'])).toBe(2);
    expect(lastJsonLine(inherited.stderr())).toMatchObject({
      message: 'unknown template "toString"; configured: bug, task',
    });
    const out = withTemplates();
    expect(await out.run(['jira', 'templates', 'bug', '--out', 'work/desc.md'])).toBe(0);
    expect(out.stdout()).toBe('wrote work/desc.md\n');
    expect(out.fs.files.get('/home/u/proj/work/desc.md')).toBe('## Steps\n\n1.\n\n## Expected\n');
    const noName = withTemplates();
    expect(await noName.run(['jira', 'templates', '--out', 'x.md'])).toBe(2);
    const axi = withTemplates();
    await axi.run(['jira', 'templates', '--axi']);
    expect(axi.stdout()).toContain('templates[2]');
    expect(axi.stdout()).toContain('help[1]:\n  Run `lassi jira templates <NAME>`');
  });
});

describe('lassi jira issue editmeta --json', () => {
  it('names the key beside the field map', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'editmeta', 'PROJ-123', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout())).toMatchObject({
      key: 'PROJ-123',
      fields: { summary: { name: 'Summary' } },
    });
  });
});
