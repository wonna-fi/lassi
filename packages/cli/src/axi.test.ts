import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from './test/program.js';

const ISSUE = {
  id: '40213',
  key: 'PROJ-123',
  fields: {
    summary: 'Login page throws 500 on empty password',
    description: 'h2. Steps\n# one\n# two',
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
          body: `first *comment* ${'word '.repeat(60)}end`,
          created: '2026-09-01T10:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
      ],
      total: 1,
      startAt: 0,
      maxResults: 1,
    },
    attachment: [
      {
        id: '1',
        filename: 'stack.png',
        mimeType: 'image/png',
        size: 3,
        content: 'https://jira.example.internal/secure/attachment/1/stack.png',
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
  },
  names: {},
  schema: { customfield_10001: { type: 'option', custom: 'select' } },
};

const ROUTES: Route[] = [
  { path: '/rest/api/2/issue/PROJ-123', json: ISSUE },
  {
    method: 'POST',
    path: '/rest/api/2/search',
    handler: (call) => {
      const { jql } = JSON.parse(call.bodyText ?? '{}') as { jql: string };
      if (jql.includes('nothing'))
        return { json: { issues: [], total: 0, startAt: 0, maxResults: 50 } };
      return {
        json: {
          startAt: 0,
          maxResults: 2,
          total: 3,
          issues: [
            {
              id: '1',
              key: 'PROJ-1',
              fields: {
                summary: 'Login, 500: bad',
                status: { name: 'Open' },
                assignee: { name: 'jsmith' },
                updated: '2026-09-03T14:02:10.000+0300',
              },
            },
            {
              id: '2',
              key: 'PROJ-2',
              fields: {
                summary: 'Other',
                status: { name: 'Done' },
                assignee: null,
                updated: '2026-09-02T10:00:00.000+0300',
              },
            },
          ],
        },
      };
    },
  },
  { path: '/rest/api/2/issue/PROJ-123/comment', json: ISSUE.fields.comment },
  { path: '/rest/api/2/myself', json: { name: 'jsmith', displayName: 'John Smith' } },
  { path: '/rest/api/2/user', json: { name: 'jsmith', displayName: 'Known' } },
  { method: 'POST', path: '/rest/api/2/issue/PROJ-123/comment', json: { id: '3', body: 'x' } },
  {
    method: 'POST',
    path: '/rest/api/2/issue/PROJ-400/comment',
    status: 400,
    json: { errorMessages: ['Comment body can not be empty!'], errors: {} },
  },
];

const WORKSPACE = {
  '/home/u/proj/.lassi.json': JSON.stringify({ jira: { fields: { team: 'customfield_10001' } } }),
};

function program(files: Record<string, string> = WORKSPACE) {
  return makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES, files });
}

describe('--axi', () => {
  it('is mutually exclusive with --json and appears once in help --all', async () => {
    const t = program();
    expect(await t.run(['--json', '--axi', 'config', 'show'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toEqual({
      code: 'usage',
      message: '--json and --axi are mutually exclusive',
    });
    expect(t.stdout()).toBe('');
    const help = program();
    await help.run(['help', '--all']);
    expect(help.stdout().split('--axi').length - 1).toBe(1);
  });

  it('prints a search as one TOON document with next steps, before or after the command', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'search', 'project = PROJ', '--axi'])).toBe(0);
    expect(t.stdout()).toBe(
      [
        'total: 3',
        'shown: 2',
        'issues[2]{key,summary,status,assignee,updated}:',
        '  PROJ-1,"Login, 500: bad",Open,jsmith,"2026-09-03T14:02:10.000+0300"',
        '  PROJ-2,Other,Done,"","2026-09-02T10:00:00.000+0300"',
        'help[2]:',
        '  Run `lassi jira issue get <KEY>` for the description and counts.',
        '  Add --limit N or --all to see the remaining 1 issue.',
        '',
      ].join('\n')
    );
    const before = program();
    await before.run(['--axi', 'jira', 'issue', 'search', 'project = PROJ']);
    expect(before.stdout()).toBe(t.stdout());

    const empty = program();
    expect(await empty.run(['jira', 'issue', 'search', 'text ~ nothing', '--axi'])).toBe(0);
    expect(empty.stdout()).toContain('total: 0\n');
    expect(empty.stdout()).toContain(
      'help[1]:\n  No issues match; broaden the JQL or check the project key.\n'
    );
  });

  it('renders an issue with aliases, the full description and the hidden count, smaller than --json', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--axi'])).toBe(0);
    const out = t.stdout();
    expect(out).toContain(
      'issue:\n  key: PROJ-123\n  summary: Login page throws 500 on empty password\n'
    );
    expect(out).toContain('  team: Platform\n');
    expect(out).not.toContain('customfield_10001');
    expect(out).toContain('  status: In Progress\n');
    expect(out).toContain('  counts:\n    comments: 1\n    attachments: 1\n    links: 1\n');
    expect(out).toContain('description: "## Steps\\n\\n1. one\\n2. two\\n"');
    expect(out).toContain('hidden: 3\n');
    expect(out).toContain(
      'help[3]:\n  Run `lassi jira comment add PROJ-123 --body "..."` to comment.\n'
    );
    expect(out).toContain(
      'Add --comments, --attachments or --links (or --all) to see the 3 hidden items.'
    );
    const json = program();
    await json.run(['jira', 'issue', 'get', 'PROJ-123', '--json']);
    expect(out.length).toBeLessThan(json.stdout().length);

    const all = program();
    await all.run(['jira', 'issue', 'get', 'PROJ-123', '--all', '--axi']);
    expect(all.stdout()).toContain(
      'attachments[1]{id,filename,size,mimeType}:\n  "1",stack.png,3,image/png\n'
    );
    expect(all.stdout()).toContain(
      'links[1]{id,type,direction,key,summary,status}:\n  "9",Blocks,blocks,PROJ-2,Other,Open\n'
    );
    expect(all.stdout()).toContain('hidden: 0\n');
    expect(all.stdout()).toContain('comments[1]{id,author,created,body}:');
  });

  it('names a next step for an empty changelog', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'changelog', 'PROJ-123', '--axi'])).toBe(0);
    expect(t.stdout()).toContain('shown: 0');
    expect(t.stdout()).toContain('help[1]:\n  No changes in that window');
  });

  it('cuts comment bodies at 200 characters in lists and says so', async () => {
    const t = program();
    expect(await t.run(['jira', 'comment', 'list', 'PROJ-123', '--axi'])).toBe(0);
    const out = t.stdout();
    expect(out).toContain(
      'key: PROJ-123\ntotal: 1\nshown: 1\nincomplete: false\ncomplete: true\ncomments[1]{id,author,created,body}:\n'
    );
    const row = out.split('\n').find((l) => l.startsWith('  "1",jdoe,')) ?? '';
    expect(row).toContain('first **comment**');
    expect(row.endsWith('…"') || row.endsWith('…')).toBe(true);
    expect(out).toContain(
      'help[1]:\n  Bodies are cut at 200 characters; use --json for the full text.\n'
    );
  });

  it('renders a dry run as data (no block), sends nothing, and leaves errors on stderr unchanged', async () => {
    const dry = program();
    expect(
      await dry.run(['jira', 'comment', 'add', 'PROJ-123', '--body', 'x', '--dry-run', '--axi'])
    ).toBe(0);
    expect(dry.stdout()).not.toContain('DRY RUN');
    expect(dry.stdout()).toContain(
      'dryRun: true\nmethod: POST\npath: /rest/api/2/issue/PROJ-123/comment\n'
    );
    expect(dry.stdout()).toContain('help[1]:\n  Re-run without --dry-run to send.\n');
    expect(dry.fetch.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);

    const axi = program();
    expect(await axi.run(['jira', 'comment', 'add', 'PROJ-400', '--body', 'x', '--axi'])).toBe(5);
    const json = program();
    expect(await json.run(['jira', 'comment', 'add', 'PROJ-400', '--body', 'x', '--json'])).toBe(5);
    expect(axi.stderr()).toBe(json.stderr());
    expect(axi.stdout()).toBe('');
    expect(lastJsonLine(axi.stderr())).toMatchObject({ code: 'validation', http: 400 });
  });

  it('shapes config show, honours output.axi in a file, and lets a flag override a file', async () => {
    const t = program();
    expect(await t.run(['config', 'show', '--axi'])).toBe(0);
    expect(t.stdout()).toContain('files:\n');
    expect(t.stdout()).toContain('settings[');
    expect(t.stdout()).toContain('{key,value,source}:');
    expect(t.stdout()).toContain('help[1]:\n  Edit ~/.lassi.json');

    const fromFile = program({
      ...WORKSPACE,
      '/home/u/.lassi.json': JSON.stringify({ output: { axi: true } }),
    });
    await fromFile.run(['jira', 'issue', 'search', 'project = PROJ']);
    expect(fromFile.stdout().startsWith('total: 3\n')).toBe(true);

    const flagWins = program({
      ...WORKSPACE,
      '/home/u/.lassi.json': JSON.stringify({ output: { json: true } }),
    });
    await flagWins.run(['jira', 'issue', 'search', 'project = PROJ', '--axi']);
    expect(flagWins.stdout().startsWith('total: 3\n')).toBe(true);

    const both = program({
      ...WORKSPACE,
      '/home/u/.lassi.json': JSON.stringify({ output: { json: true, axi: true } }),
    });
    expect(await both.run(['config', 'show'])).toBe(2);
    expect(lastJsonLine(both.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('mutually exclusive'),
    });
  });
});
