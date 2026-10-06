import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const ISSUE = {
  id: '40213',
  key: 'PROJ-123',
  fields: {
    summary: 'Login page throws 500 on empty password',
    description: 'h2. Steps\n# one',
    project: { id: '10000', key: 'PROJ' },
    issuetype: { id: '1', name: 'Bug' },
    priority: { id: '2', name: 'High' },
    status: { name: 'In Progress' },
    assignee: { name: 'jsmith', displayName: 'John Smith' },
    reporter: { name: 'jdoe', displayName: 'Jane Doe' },
    labels: ['auth'],
    created: '2026-08-30T09:12:44.000+0300',
    updated: '2026-09-03T14:02:10.000+0300',
    customfield_10001: { id: '1', value: 'Platform' },
    comment: {
      comments: [
        {
          id: '1',
          body: 'first',
          created: '2026-09-01T10:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
      ],
      total: 1,
      startAt: 0,
      maxResults: 1,
    },
  },
  names: {},
  schema: { customfield_10001: { type: 'option', custom: 'select' } },
};

const ROUTES: Route[] = [
  { path: '/rest/api/2/myself', json: { name: 'jsmith', displayName: 'John Smith' } },
  {
    path: '/rest/api/2/user',
    handler: (call) => {
      const username = call.url.searchParams.get('username');
      return username === 'jsmith' || username === 'jdoe'
        ? { json: { name: username, displayName: 'Known' } }
        : { status: 404, json: { errorMessages: ["The user named 'ghost' does not exist"] } };
    },
  },
  {
    method: 'POST',
    path: '/rest/api/2/issue/PROJ-123/comment',
    handler: (call) => ({ json: { id: '3', body: JSON.parse(call.bodyText ?? '{}').body } }),
  },
  { method: 'PUT', path: '/rest/api/2/issue/PROJ-123/comment/2', json: { id: '2', body: 'x' } },
  {
    method: 'GET',
    path: '/rest/api/2/issue/PROJ-123/comment/2',
    json: {
      id: '2',
      body: 'second',
      created: '2026-09-02T10:00:00.000+0300',
      author: { name: 'jsmith' },
    },
  },
  {
    method: 'GET',
    path: '/rest/api/2/issue/PROJ-123/comment/1',
    json: {
      id: '1',
      body: 'first',
      created: '2026-09-01T10:00:00.000+0300',
      author: { name: 'jdoe' },
    },
  },
  { method: 'DELETE', path: /\/rest\/api\/2\/issue\/PROJ-123\/comment\/\d+/, status: 204 },
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
  { method: 'POST', path: '/rest/api/2/issue', json: { id: '9', key: 'PROJ-9' } },
  { method: 'GET', path: '/rest/api/2/issue/PROJ-123', json: ISSUE },
  {
    path: '/rest/api/2/issue/PROJ-123/editmeta',
    json: {
      fields: {
        summary: { name: 'Summary', required: true, schema: { type: 'string' } },
        description: { name: 'Description', required: false, schema: { type: 'string' } },
        customfield_10001: {
          name: 'Team',
          required: false,
          schema: { type: 'option' },
          allowedValues: [{ value: 'Platform' }, { value: 'Web' }],
        },
        labels: { name: 'Labels', required: false, schema: { type: 'array', items: 'string' } },
      },
    },
  },
  { method: 'PUT', path: '/rest/api/2/issue/PROJ-123', status: 204 },
  {
    method: 'GET',
    path: '/rest/api/2/issue/PROJ-123/transitions',
    json: {
      transitions: [
        {
          id: '31',
          name: 'Done',
          to: { name: 'Done' },
          fields: {
            resolution: {
              name: 'Resolution',
              required: true,
              schema: { type: 'resolution' },
              allowedValues: [{ name: 'Fixed' }, { name: "Won't Fix" }],
            },
          },
        },
        { id: '11', name: 'Start', to: { name: 'In Progress' }, fields: {} },
      ],
    },
  },
  { method: 'POST', path: '/rest/api/2/issue/PROJ-123/transitions', status: 204 },
  {
    method: 'POST',
    path: '/rest/api/2/issue/PROJ-123/attachments',
    json: [{ id: '77', filename: 'shot.png', size: 3, mimeType: 'image/png' }],
  },
  {
    path: '/rest/api/2/issueLinkType',
    json: {
      issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    },
  },
  { method: 'POST', path: '/rest/api/2/issueLink', status: 201 },
];

const WORKSPACE = {
  '/home/u/proj/.lassi.json': JSON.stringify({
    jira: {
      fields: { team: { id: 'customfield_10001', editable: true } },
      defaultProject: 'PROJ',
    },
  }),
};

function program(
  opts: {
    routes?: Route[];
    env?: Record<string, string>;
    stdin?: string;
    files?: Record<string, string>;
  } = {}
) {
  return makeTestProgram({
    env: { ...BOTH_PRODUCTS_ENV, ...opts.env },
    routes: [...(opts.routes ?? []), ...ROUTES],
    files: { ...WORKSPACE, ...opts.files },
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
  });
}

const writes = (t: ReturnType<typeof program>) => t.fetch.calls.filter((c) => c.method !== 'GET');

const APPENDIX_B_MD =
  '### Root cause\n\nThe password field is *optional* in the DTO but the validator assumes it is present.\n\n```ts\nconst pw = dto.password.trim();\n```\n';
const APPENDIX_B_WIKI =
  'h3. Root cause\n\nThe password field is _optional_ in the DTO but the validator assumes it is present.\n\n{code:ts}\nconst pw = dto.password.trim();\n{code}\n';

describe('lassi jira issue comment add|edit|delete', () => {
  it('converts the body to wiki markup, posts it and prints the id', async () => {
    const t = program();
    expect(
      await t.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', APPENDIX_B_MD])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({ body: APPENDIX_B_WIKI });
    expect(t.stdout()).toBe('comment 3 added to PROJ-123\n');
  });

  it('--dry-run prints the Appendix B block and sends no write', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'comment',
        'add',
        'PROJ-123',
        '--body',
        APPENDIX_B_MD,
        '--dry-run',
      ])
    ).toBe(0);
    expect(t.stdout()).toBe(
      `DRY RUN — nothing sent\nPOST /rest/api/2/issue/PROJ-123/comment\n--- body (wiki markup) ---\n${APPENDIX_B_WIKI}`
    );
    expect(writes(t)).toHaveLength(0);
  });

  it('--dry-run --json prints one document with the preview', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'comment',
        'add',
        'PROJ-123',
        '--body',
        '# hi',
        '--dry-run',
        '--json',
      ])
    ).toBe(0);
    expect(JSON.parse(t.stdout())).toEqual({
      dryRun: true,
      method: 'POST',
      path: '/rest/api/2/issue/PROJ-123/comment',
      payloadLabel: 'body (wiki markup)',
      payload: 'h1. hi\n',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('exits 7 under LASSI_READ_ONLY before any request', async () => {
    const t = program({ env: { LASSI_READ_ONLY: '1' } });
    expect(await t.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', '# hi'])).toBe(7);
    expect(t.fetch.calls).toHaveLength(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'read_only' });
  });

  it('reads the body from --file or piped stdin', async () => {
    const fromFile = program({ files: { '/home/u/proj/note.md': '# from file\n' } });
    expect(
      await fromFile.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--file', 'note.md'])
    ).toBe(0);
    expect(JSON.parse(writes(fromFile)[0]?.bodyText ?? '')).toEqual({ body: 'h1. from file\n' });
    const fromStdin = program({ stdin: '# from stdin\n' });
    expect(await fromStdin.run(['jira', 'issue', 'comment', 'add', 'PROJ-123'])).toBe(0);
    expect(JSON.parse(writes(fromStdin)[0]?.bodyText ?? '')).toEqual({ body: 'h1. from stdin\n' });
    const nothing = program();
    expect(await nothing.run(['jira', 'issue', 'comment', 'add', 'PROJ-123'])).toBe(2);
    expect(lastJsonLine(nothing.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('--body'),
    });
  });

  it('refuses pasted wiki markup with exit 2 and the fence hint', async () => {
    const t = program();
    expect(
      await t.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', 'h1. Title\n'])
    ).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('looks like Jira wiki markup'),
      hint: expect.stringContaining('```jira'),
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('validates mentions before sending and writes them as [~user]', async () => {
    const ok = program();
    expect(
      await ok.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', 'ping @jsmith'])
    ).toBe(0);
    expect(JSON.parse(writes(ok)[0]?.bodyText ?? '')).toEqual({ body: 'ping [~jsmith]\n' });
    const bad = program();
    expect(
      await bad.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', 'ping @ghost'])
    ).toBe(5);
    expect(lastJsonLine(bad.stderr())).toMatchObject({
      code: 'validation',
      message: 'unknown user: @ghost',
    });
    expect(writes(bad)).toHaveLength(0);
  });

  it('reports lossy conversions as warnings on stderr', async () => {
    const t = program();
    expect(
      await t.run(['jira', 'issue', 'comment', 'add', 'PROJ-123', '--body', '3. a\n4. b\n'])
    ).toBe(0);
    expect(t.stderr()).toContain('warn: ordered list starting at 3 restarts at 1 in Jira (line 1)');
  });

  it('edits a comment with PUT', async () => {
    const t = program();
    expect(
      await t.run(['jira', 'issue', 'comment', 'edit', 'PROJ-123', '2', '--body', '**fixed**'])
    ).toBe(0);
    const put = writes(t)[0];
    expect(put?.method).toBe('PUT');
    expect(put?.url.pathname).toBe('/rest/api/2/issue/PROJ-123/comment/2');
    expect(JSON.parse(put?.bodyText ?? '')).toEqual({ body: '*fixed*\n' });
    expect(t.stdout()).toBe('comment 2 edited on PROJ-123\n');
  });

  it('deletes own comments, refuses others unless --any, and previews the delete', async () => {
    const own = program();
    expect(await own.run(['jira', 'issue', 'comment', 'delete', 'PROJ-123', '2'])).toBe(0);
    expect(writes(own)[0]?.method).toBe('DELETE');
    expect(own.stdout()).toBe('comment 2 deleted from PROJ-123\n');

    const other = program();
    expect(await other.run(['jira', 'issue', 'comment', 'delete', 'PROJ-123', '1'])).toBe(5);
    expect(lastJsonLine(other.stderr())).toMatchObject({
      code: 'validation',
      message: 'comment 1 on PROJ-123 was written by jdoe, not by you (jsmith)',
      hint: expect.stringContaining('--any'),
    });
    expect(writes(other)).toHaveLength(0);

    const forced = program();
    expect(await forced.run(['jira', 'issue', 'comment', 'delete', 'PROJ-123', '1', '--any'])).toBe(
      0
    );
    expect(writes(forced)[0]?.url.pathname).toBe('/rest/api/2/issue/PROJ-123/comment/1');

    const dry = program();
    expect(
      await dry.run(['jira', 'issue', 'comment', 'delete', 'PROJ-123', '1', '--any', '--dry-run'])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      'DRY RUN — nothing sent\nDELETE /rest/api/2/issue/PROJ-123/comment/1\n--- comment ---\n1 by jdoe, 2026-09-01T10:00:00.000+0300\n'
    );
    expect(writes(dry)).toHaveLength(0);
  });

  it('rejects a malformed key before reading the body', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'comment', 'add', 'proj-1', '--body', 'x'])).toBe(2);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it.each([
    ['delete', 'PROJ-123', '..', '--any'],
    ['delete', 'PROJ-123', '.', '--any', '--dry-run'],
    ['edit', 'PROJ-123', '..', '--body', 'x'],
    ['edit', 'PROJ-123', '..', '--body', 'x', '--dry-run'],
    ['edit', 'PROJ-123', '10001x', '--body', 'x'],
  ])('refuses comment %s with a non-numeric id before any request: %s %s', async (...args) => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'comment', ...args])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('not a Jira comment id'),
    });
    expect(t.fetch.calls).toHaveLength(0);
    expect(t.stdout()).toBe('');
  });
});

describe('lassi jira issue create', () => {
  const base = ['jira', 'issue', 'create', '--type', 'Bug', '--summary', 'Broken login'];

  it('coerces fields with createmeta, converts the description and posts', async () => {
    const t = program();
    expect(
      await t.run([...base, '--field', 'team=web', '--field', 'labels=a,b', '--body', '# Steps'])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: {
        customfield_10001: { value: 'Web' },
        labels: ['a', 'b'],
        project: { key: 'PROJ' },
        issuetype: { name: 'Bug' },
        summary: 'Broken login',
        description: 'h1. Steps\n',
      },
    });
    expect(t.stdout()).toBe('created PROJ-9 https://jira.example.internal/browse/PROJ-9\n');
  });

  it('fails fast on missing required fields with the createmeta hint (exit 5, no POST)', async () => {
    const t = program();
    expect(await t.run(base)).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: 'missing required field: team',
      errors: { customfield_10001: 'Team is required.' },
      errorsByAlias: { team: 'Team is required.' },
      hint: expect.stringContaining('lassi jira issue createmeta PROJ --type Bug'),
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('renders a fabricated 400 as the Appendix B contract', async () => {
    const t = program({
      routes: [
        {
          method: 'POST',
          path: '/rest/api/2/issue',
          status: 400,
          json: { errorMessages: [], errors: { customfield_10001: 'Team is required.' } },
        },
      ],
    });
    expect(await t.run([...base, '--field', 'team=Web', '--quiet'])).toBe(5);
    const lines = t.stderr().trim().split('\n');
    expect(lines[0]).toBe('error: Jira rejected the request (400): Team is required.');
    expect(JSON.parse(lines[1] as string)).toEqual({
      code: 'validation',
      http: 400,
      message: 'Team is required.',
      errors: { customfield_10001: 'Team is required.' },
      errorsByAlias: { team: 'Team is required.' },
      errorMessages: [],
      hint: 'Add --field team=<value>; run `lassi jira issue createmeta PROJ --type Bug` for allowed values.',
      request: { method: 'POST', url: '/rest/api/2/issue' },
    });
    expect(t.stdout()).toBe('');
  });

  it('--dry-run prints the fields payload after the createmeta pre-check and sends nothing', async () => {
    const t = program();
    expect(await t.run([...base, '--field', 'team=Web', '--dry-run'])).toBe(0);
    expect(t.stdout()).toMatch(
      /^DRY RUN — nothing sent\nPOST \/rest\/api\/2\/issue\n--- fields \(json\) ---\n\{/
    );
    expect(t.stdout()).toContain('"summary": "Broken login"');
    expect(writes(t)).toHaveLength(0);
  });

  it('rejects unknown types, aliases and disallowed values before sending', async () => {
    const type = program();
    expect(await type.run(['jira', 'issue', 'create', '--type', 'Epic', '--summary', 's'])).toBe(5);
    expect(lastJsonLine(type.stderr())).toMatchObject({
      message: 'issue type "Epic" is not available in PROJ; available: Bug',
    });
    const alias = program();
    expect(await alias.run([...base, '--field', 'nope=1'])).toBe(2);
    expect(lastJsonLine(alias.stderr())).toMatchObject({
      message: expect.stringContaining('unknown field "nope"'),
    });
    // The alias map comes from JSON, so a bare lookup found Object.prototype and PUT
    // `{"function toString() { [native code] }": "x"}` with exit 0.
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      const proto = program();
      expect(await proto.run([...base, '--field', `${name}=x`])).toBe(2);
      expect(lastJsonLine(proto.stderr())).toMatchObject({
        message: expect.stringContaining(`unknown field "${name}"`),
      });
      expect(proto.fetch.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    }
    const value = program();
    expect(await value.run([...base, '--field', 'team=Nope'])).toBe(5);
    expect(lastJsonLine(value.stderr())).toMatchObject({
      code: 'validation',
      errorsByAlias: { team: 'Allowed: Platform, Web' },
      hint: expect.stringContaining('Allowed values'),
    });
    expect([type, alias, value].flatMap((t) => writes(t))).toHaveLength(0);
  });

  it('requires a project when none is configured', async () => {
    const t = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: ROUTES });
    expect(await t.run(['jira', 'issue', 'create', '--type', 'Bug', '--summary', 's'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: expect.stringContaining('--project'),
    });
  });
});

describe('lassi jira issue update', () => {
  it('sends --field values coerced against editmeta', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--field',
        'summary=New',
        '--field',
        'team=web',
      ])
    ).toBe(0);
    const put = writes(t)[0];
    expect(put?.method).toBe('PUT');
    expect(JSON.parse(put?.bodyText ?? '')).toEqual({
      fields: { summary: 'New', customfield_10001: { value: 'Web' } },
    });
    expect(t.stdout()).toBe('updated PROJ-123 (summary, team)\n');
  });

  it('replaces the description from --body', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--body', '## New\n\n- a'])).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { description: 'h2. New\n\n* a\n' },
    });
  });

  it('diffs a working file against its cache, sends the changes and rewrites the file', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md'])).toBe(0);
    const path = '/home/u/proj/work/PROJ-123.md';
    const original = await t.fs.readFile(path);
    await t.fs.writeFile(
      path,
      original
        .replace('summary: Login page throws 500 on empty password', 'summary: New summary')
        .replace('1. one\n', '1. one\n2. two\n')
    );
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])).toBe(
      0
    );
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { summary: 'New summary', description: 'h2. Steps\n\n# one\n# two\n' },
    });
    expect(t.stdout()).toBe(
      'wrote work/PROJ-123.md (cache: .lassi/cache/jira/PROJ-123.json)\n(1 comment not shown — use --comments, --attachments, --links or --all)\nupdated PROJ-123 (summary, description); rewrote work/PROJ-123.md\n'
    );
    // The fake server did not persist the change, so the rewrite restores the server's summary.
    expect(await t.fs.readFile(path)).toContain('summary: Login page throws 500 on empty password');
  });

  it('fails and keeps the edited file when a proxy answers the PUT with a 200 page', async () => {
    const t = program({
      routes: [
        {
          method: 'PUT',
          path: '/rest/api/2/issue/PROJ-123',
          text: '<html><body>Request blocked</body></html>',
          headers: { 'content-type': 'text/html' },
        },
      ],
    });
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md'])).toBe(0);
    const path = '/home/u/proj/work/PROJ-123.md';
    const edited = (await t.fs.readFile(path)).replace(
      'summary: Login page throws 500 on empty password',
      'summary: New summary'
    );
    await t.fs.writeFile(path, edited);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])).toBe(
      1
    );
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'http', http: 200 });
    expect(t.stdout()).not.toContain('updated PROJ-123');
    expect(await t.fs.readFile(path)).toBe(edited);
  });

  it('exits 0 with "no changes" and no PUT when the file matches the cache', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])).toBe(
      0
    );
    expect(writes(t)).toHaveLength(0);
    expect(t.stdout()).toContain('no changes for PROJ-123\n');
  });

  it('--if-unchanged exits 6 with the re-fetch hint when the issue moved on', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const moved = program({
      routes: [
        {
          method: 'GET',
          path: '/rest/api/2/issue/PROJ-123',
          json: { ...ISSUE, fields: { ...ISSUE.fields, updated: '2026-09-04T00:00:00.000+0300' } },
        },
      ],
      files: Object.fromEntries(t.fs.files.entries()),
    });
    expect(
      await moved.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--file',
        'work/PROJ-123.md',
        '--if-unchanged',
        '--field',
        'summary=x',
      ])
    ).toBe(6);
    expect(lastJsonLine(moved.stderr())).toMatchObject({
      code: 'conflict',
      hint: 'Issue changed on server; run `lassi jira issue get PROJ-123 --out work/PROJ-123.md` and re-apply your edit.',
    });
    expect(writes(moved)).toHaveLength(0);
  });

  it('refuses a file without its cache, an unknown frontmatter key and edited generated sections', async () => {
    const noCache = program({
      files: { '/home/u/proj/work/PROJ-123.md': '---\nkey: PROJ-123\nsummary: x\n---\n\nbody\n' },
    });
    expect(
      await noCache.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])
    ).toBe(2);
    expect(lastJsonLine(noCache.stderr())).toMatchObject({
      hint: 'run `lassi jira issue get PROJ-123 --out work/PROJ-123.md` first',
    });

    const unknownKey = program();
    await unknownKey.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const path = '/home/u/proj/work/PROJ-123.md';
    await unknownKey.fs.writeFile(
      path,
      (await unknownKey.fs.readFile(path)).replace('summary:', 'bogus: 1\nsummary:')
    );
    expect(
      await unknownKey.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])
    ).toBe(2);
    expect(lastJsonLine(unknownKey.stderr())).toMatchObject({
      message: expect.stringContaining('unknown field "bogus"'),
    });

    const sections = program();
    await sections.run([
      'jira',
      'issue',
      'get',
      'PROJ-123',
      '--out',
      'work/PROJ-123.md',
      '--comments',
    ]);
    await sections.fs.writeFile(
      path,
      (await sections.fs.readFile(path)).replace('## Comments', '## Comments (edited)')
    );
    expect(
      await sections.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])
    ).toBe(2);
    expect(lastJsonLine(sections.stderr())).toMatchObject({
      message: expect.stringContaining('generated sections'),
    });
    expect([noCache, unknownKey, sections].flatMap((t) => writes(t))).toHaveLength(0);
  });

  it('keeps the file untouched with --keep and previews with --dry-run', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const path = '/home/u/proj/work/PROJ-123.md';
    const before = await t.fs.readFile(path);
    const edited = before.includes('[auth]')
      ? before.replace('[auth]', '[auth, urgent]')
      : before.replace('- auth', '- auth\n  - urgent');
    await t.fs.writeFile(path, edited);
    expect(
      await t.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--file',
        'work/PROJ-123.md',
        '--dry-run',
      ])
    ).toBe(0);
    expect(t.stdout()).toContain(
      'DRY RUN — nothing sent\nPUT /rest/api/2/issue/PROJ-123\n--- fields (json) ---\n'
    );
    expect(writes(t)).toHaveLength(0);
    expect(
      await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md', '--keep'])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { labels: ['auth', 'urgent'] },
    });
    expect(await t.fs.readFile(path)).toBe(edited);
  });

  it('requires something to update', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123'])).toBe(2);
    expect(t.fetch.calls).toHaveLength(0);
  });
});

describe('lassi jira issue update: --if-unchanged', () => {
  it('refuses the flag without a working file rather than pretending to guard the write', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--field',
        'summary=New',
        '--if-unchanged',
      ])
    ).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('needs --file'),
    });
    expect(writes(t)).toHaveLength(0);
  });
});

describe('lassi jira issue update: one cache entry per working file', () => {
  it('strips the sections this file was fetched with, not those of a later fetch', async () => {
    const t = program();
    // The same issue in two files: only the first carries the generated comments section.
    expect(
      await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/a.md', '--comments'])
    ).toBe(0);
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/b.md'])).toBe(0);
    const a = await t.fs.readFile('/home/u/proj/work/a.md');
    expect(a).toContain('## Comments');
    await t.fs.writeFile('/home/u/proj/work/a.md', a.replace('## Steps', '## Steps, edited'));
    expect(
      await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/a.md', '--keep'])
    ).toBe(0);
    const sent = JSON.parse(writes(t)[0]?.bodyText ?? '{}') as {
      fields: { description?: string };
    };
    expect(sent.fields.description).toBe('h2. Steps, edited\n\n# one\n');
  });

  it('refuses a working file it has no record of', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const file = await t.fs.readFile('/home/u/proj/work/PROJ-123.md');
    await t.fs.writeFile('/home/u/proj/work/copy.md', file);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/copy.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('no record of work/copy.md'),
    });
    expect(writes(t)).toHaveLength(0);
  });
});

const EDITMETA_CACHE = '/home/u/proj/.lassi/cache/jira/editmeta/PROJ.1.json';

function cachedEditmeta(fetchedAt: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    baseUrl: 'https://jira.example.internal',
    project: 'PROJ',
    issueTypeId: '1',
    fetchedAt,
    fields: {
      customfield_10001: {
        fieldId: 'customfield_10001',
        name: 'Team',
        required: false,
        schema: { type: 'option' },
        allowedValues: [{ value: 'Platform' }, { value: 'Web' }],
      },
    },
    ...extra,
  });
}

const editmetaCalls = (t: ReturnType<typeof program>) =>
  t.fetch.calls.filter((c) => c.url.pathname.endsWith('/editmeta'));

describe('lassi jira issue update: edit metadata only when a change needs it', () => {
  it('does not fetch it for the description, plain fields or clearing a field', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--body', 'x'])).toBe(0);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'summary=New'])).toBe(0);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=-'])).toBe(0);
    expect(JSON.parse(writes(t)[2]?.bodyText ?? '')).toEqual({
      fields: { customfield_10001: null },
    });
    expect(editmetaCalls(t)).toHaveLength(0);
    expect(t.stderr()).toBe('');
  });

  it('does not fetch it for an unchanged file or a labels-only change', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md'])).toBe(
      0
    );
    const path = '/home/u/proj/work/PROJ-123.md';
    await t.fs.writeFile(
      path,
      (await t.fs.readFile(path)).replace('  - auth\n', '  - auth\n  - urgent\n')
    );
    expect(
      await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work/PROJ-123.md', '--keep'])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { labels: ['auth', 'urgent'] },
    });
    expect(editmetaCalls(t)).toHaveLength(0);
  });

  it('fetches it once for an option field, says so, and serves the next update from the cache', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=web'])).toBe(0);
    expect(t.stderr()).toBe(
      'warn: fetching edit metadata for PROJ-123 to check team; Jira can take minutes to answer this on a large project\n'
    );
    const probe = t.fetch.calls.find((c) => c.url.pathname === '/rest/api/2/issue/PROJ-123');
    expect(probe?.url.search).toBe('?fields=project%2Cissuetype');
    expect(JSON.parse(await t.fs.readFile(EDITMETA_CACHE))).toMatchObject({
      schema: 1,
      baseUrl: 'https://jira.example.internal',
      project: 'PROJ',
      issueTypeId: '1',
      fetchedAt: '2026-09-04T10:00:00.000Z',
      fields: { customfield_10001: { allowedValues: [{ value: 'Platform' }, { value: 'Web' }] } },
    });
    expect([...t.fs.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);

    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=platform'])).toBe(
      0
    );
    expect(editmetaCalls(t)).toHaveLength(1);
    expect(JSON.parse(writes(t)[1]?.bodyText ?? '')).toEqual({
      fields: { customfield_10001: { value: 'Platform' } },
    });
  });

  it('fetches it again when the cache is stale or from another server', async () => {
    for (const cache of [
      cachedEditmeta('2026-09-03T09:59:59.000Z'),
      cachedEditmeta('2026-09-04T09:00:00.000Z', { baseUrl: 'https://other.example.internal' }),
    ]) {
      const t = program({ files: { [EDITMETA_CACHE]: cache } });
      expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=web'])).toBe(0);
      expect(editmetaCalls(t)).toHaveLength(1);
    }
  });

  it('rejects a value outside the cached allowed values without fetching, and says how to refresh', async () => {
    const t = program({ files: { [EDITMETA_CACHE]: cachedEditmeta('2026-09-04T09:00:00.000Z') } });
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=Mobile'])).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      hint: expect.stringContaining(
        'The allowed values were cached at 2026-09-04T09:00:00.000Z; run `lassi jira issue editmeta PROJ-123` to refresh them'
      ),
    });
    expect(editmetaCalls(t)).toHaveLength(0);
    expect(writes(t)).toHaveLength(0);
  });

  it('decides by the value that is sent when a field is given twice', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--field',
        'team=Web',
        '--field',
        'team=-',
      ])
    ).toBe(0);
    expect(editmetaCalls(t)).toHaveLength(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10001: null },
    });
    expect(t.stdout()).toBe('updated PROJ-123 (team)\n');
  });

  it('treats a cache it cannot read as a miss and asks Jira', async () => {
    const t = program({ files: { [`${EDITMETA_CACHE}/stray`]: '' } });
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=web'])).toBe(0);
    expect(t.stderr()).toContain('warn: could not read cached edit metadata');
    expect(editmetaCalls(t)).toHaveLength(1);
  });

  it('refuses, and does not cache, an empty answer, which a non-editable status gives', async () => {
    const t = program({
      routes: [{ path: '/rest/api/2/issue/PROJ-123/editmeta', json: { fields: {} } }],
    });
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=web'])).toBe(5);
    expect(writes(t)).toHaveLength(0);
    const err = lastJsonLine(t.stderr());
    expect(err).toMatchObject({
      code: 'validation',
      message:
        'Jira lists no editable fields for PROJ-123; its status or your permissions forbid editing',
      errors: { customfield_10001: 'not on the edit screen' },
      hint: 'check the status with `lassi jira issue get PROJ-123` and that you may edit it in Jira',
    });
    expect(await t.fs.exists(EDITMETA_CACHE)).toBe(false);
  });

  it('reuses the --if-unchanged request to find the cache', async () => {
    const t = program();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const path = '/home/u/proj/work/PROJ-123.md';
    await t.fs.writeFile(path, (await t.fs.readFile(path)).replace('team: Platform', 'team: Web'));
    const before = t.fetch.calls.length;
    expect(
      await t.run([
        'jira',
        'issue',
        'update',
        'PROJ-123',
        '--file',
        'work/PROJ-123.md',
        '--if-unchanged',
        '--keep',
      ])
    ).toBe(0);
    expect(t.fetch.calls.slice(before).map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /rest/api/2/issue/PROJ-123',
      'GET /rest/api/2/issue/PROJ-123/editmeta',
      'PUT /rest/api/2/issue/PROJ-123',
    ]);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10001: { value: 'Web' } },
    });
  });

  it('issue editmeta shows the live answer and caches it for the next update', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'editmeta', 'PROJ-123'])).toBe(0);
    expect(t.stderr()).toBe(
      'warn: fetching edit metadata for PROJ-123; Jira can take minutes to answer this on a large project\n'
    );
    expect(await t.fs.exists(EDITMETA_CACHE)).toBe(true);
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--field', 'team=web'])).toBe(0);
    expect(editmetaCalls(t)).toHaveLength(1);
  });
});

const POLICY_ISSUE = {
  ...ISSUE,
  fields: {
    ...ISSUE.fields,
    customfield_10005: 3,
    customfield_10020: 'h1. Title\n*bold* text',
    customfield_10077: 'unaliased',
  },
  names: { customfield_10077: 'Some Field' },
  schema: {
    ...ISSUE.schema,
    customfield_10005: { type: 'number' },
    customfield_10020: { type: 'string' },
    customfield_10077: { type: 'string' },
  },
};

const POLICY_FIELDS = {
  team: { id: 'customfield_10001', editable: true },
  points: 'customfield_10005',
  notes: { id: 'customfield_10020', format: 'wiki', editable: true },
};

function policyProgram(
  opts: { routes?: Route[]; env?: Record<string, string>; fields?: Record<string, unknown> } = {}
) {
  return program({
    ...(opts.env ? { env: opts.env } : {}),
    routes: [
      ...(opts.routes ?? []),
      { method: 'GET', path: '/rest/api/2/issue/PROJ-123', json: POLICY_ISSUE },
    ],
    files: {
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: opts.fields ?? POLICY_FIELDS, defaultProject: 'PROJ' },
      }),
    },
  });
}

const WORK = '/home/u/proj/work/PROJ-123.md';
const update = (...args: string[]) => ['jira', 'issue', 'update', 'PROJ-123', ...args];

describe('lassi jira issue update: field policy', () => {
  it('refuses --field on a read-only alias or an unaliased custom field before any request', async () => {
    const t = policyProgram();
    expect(await t.run(update('--field', 'points=5', '--field', 'customfield_10077=x'))).toBe(2);
    expect(t.fetch.calls).toHaveLength(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: 'read-only fields: points (customfield_10005), customfield_10077',
      hint: 'set "editable": true on jira.fields.points; add { "id": "customfield_10077", "editable": true } under jira.fields to let Lassi write them, if Jira allows it (`lassi jira fields` lists the policy)',
    });
  });

  it('accepts the raw id of a field an entry makes editable', async () => {
    const t = policyProgram();
    expect(await t.run(update('--field', 'customfield_10001=web'))).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10001: { value: 'Web' } },
    });
  });

  it('refuses a read-only field moved to the top level, and ignores an edit under readonly', async () => {
    const t = policyProgram();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md'])).toBe(0);
    const original = await t.fs.readFile(WORK);
    expect(original).toContain('\n  points: 3\n');
    expect(original).toContain('\n  customfield_10077: unaliased # Some Field\n');

    await t.fs.writeFile(WORK, original.replace('\n  points: 3\n', '\n  points: 5\n'));
    expect(await t.run(update('--file', 'work/PROJ-123.md'))).toBe(0);
    expect(t.stdout()).toContain('no changes for PROJ-123\n');
    expect(t.stderr()).toContain('warn: readonly.points was edited; ignored\n');

    await t.fs.writeFile(
      WORK,
      original.replace('\nteam: Platform\n', '\nteam: Platform\npoints: 5\n')
    );
    expect(await t.run(update('--file', 'work/PROJ-123.md'))).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: 'read-only field: points (customfield_10005)',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('refuses an edited top-level custom field from a file fetched before custom fields were read-only', async () => {
    const t = policyProgram();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    // The earlier layout: custom fields at the top level, and in the cached editable keys.
    const cachePath = '/home/u/proj/.lassi/cache/jira/PROJ-123.json';
    const cache = JSON.parse(await t.fs.readFile(cachePath));
    cache.files['work/PROJ-123.md'].editable.customfield_10077 = 'unaliased';
    await t.fs.writeFile(cachePath, JSON.stringify(cache));
    const file = await t.fs.readFile(WORK);
    const top = file.replace(
      '\nteam: Platform\n',
      '\nteam: Platform\ncustomfield_10077: unaliased\n'
    );
    await t.fs.writeFile(WORK, top);
    expect(await t.run(update('--file', 'work/PROJ-123.md'))).toBe(0);
    expect(t.stdout()).toContain('no changes for PROJ-123\n');
    await t.fs.writeFile(
      WORK,
      top.replace('customfield_10077: unaliased', 'customfield_10077: edited')
    );
    expect(await t.run(update('--file', 'work/PROJ-123.md'))).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: 'read-only field: customfield_10077',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('shows a wiki field as Markdown and sends an edit back as wiki markup', async () => {
    const t = policyProgram();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const original = await t.fs.readFile(WORK);
    expect(original).toContain('\nnotes: |-\n  # Title\n\n  **bold** text\n');
    await t.fs.writeFile(WORK, original.replace('**bold** text', '**bold** text, `code`'));
    expect(await t.run(['--dry-run', ...update('--file', 'work/PROJ-123.md')])).toBe(0);
    expect(t.stdout()).toContain('"customfield_10020": "h1. Title\\n\\n*bold* text, {{code}}\\n"');
    expect(await t.run(update('--file', 'work/PROJ-123.md', '--keep'))).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10020: 'h1. Title\n\n*bold* text, {{code}}\n' },
    });
  });

  it('takes Markdown, not JSON, from --field for a wiki field, and names it when that fails', async () => {
    const t = policyProgram();
    expect(await t.run(update('--field', 'notes=[x](https://example.test)'))).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10020: '[x|https://example.test]\n' },
    });
    expect(await t.run(update('--field', 'notes=-'))).toBe(0);
    // The same clears as every other field: surrounding whitespace does not make them Markdown.
    expect(await t.run(update('--field', 'notes= - '))).toBe(0);
    expect(await t.run(update('--field', 'notes=   '))).toBe(0);
    expect(
      writes(t)
        .slice(1)
        .map((w) => JSON.parse(w.bodyText ?? ''))
    ).toEqual([
      { fields: { customfield_10020: null } },
      { fields: { customfield_10020: null } },
      { fields: { customfield_10020: null } },
    ]);
    expect(await t.run(update('--field', 'notes=h2. Pasted wiki'))).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringMatching(/^notes: /),
    });
    expect(writes(t)).toHaveLength(4);
  });

  it('converts only the value that is sent when --field replaces a file edit', async () => {
    const t = policyProgram();
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    // Converting the file's value would look the mention up and fail on an unknown user.
    await t.fs.writeFile(
      WORK,
      (await t.fs.readFile(WORK)).replace('**bold** text', '**bold** text for @ghost')
    );
    expect(
      await t.run(update('--file', 'work/PROJ-123.md', '--keep', '--field', 'notes=plain'))
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10020: 'plain\n' },
    });
  });

  it('sends Markdown typed into a wiki field that was empty when fetched as wiki markup', async () => {
    const t = policyProgram({
      routes: [
        {
          method: 'GET',
          path: '/rest/api/2/issue/PROJ-123',
          json: { ...POLICY_ISSUE, fields: { ...POLICY_ISSUE.fields, customfield_10020: null } },
        },
      ],
    });
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    const original = await t.fs.readFile(WORK);
    expect(original).toContain('\nnotes: null\n');
    await t.fs.writeFile(WORK, original.replace('\nnotes: null\n', '\nnotes: "**now** set"\n'));
    expect(await t.run(update('--file', 'work/PROJ-123.md', '--keep'))).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10020: '*now* set\n' },
    });
  });

  it("converts by the format this file was fetched with, not another file's", async () => {
    const t = policyProgram({
      fields: { ...POLICY_FIELDS, notes: { id: 'customfield_10020', editable: true } },
    });
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    expect(await t.fs.readFile(WORK)).toContain('\nnotes: |-\n  h1. Title\n  *bold* text\n');
    await t.fs.writeFile(
      '/home/u/proj/.lassi.json',
      JSON.stringify({ jira: { fields: POLICY_FIELDS, defaultProject: 'PROJ' } })
    );
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/other.md']);
    // As a cache written before formats existed: only the later fetch, of other.md, records any.
    const cachePath = '/home/u/proj/.lassi/cache/jira/PROJ-123.json';
    const cache = JSON.parse(await t.fs.readFile(cachePath));
    expect(cache.formats).toEqual({ customfield_10020: 'wiki' });
    delete cache.files['work/PROJ-123.md'].formats;
    await t.fs.writeFile(cachePath, JSON.stringify(cache));
    await t.fs.writeFile(WORK, (await t.fs.readFile(WORK)).replace('*bold* text', '*bold* edit'));
    expect(await t.run(update('--file', 'work/PROJ-123.md', '--keep'))).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { customfield_10020: 'h1. Title\n*bold* edit' },
    });
  });

  it('takes Markdown for a wiki field on create, from --field and from a template', async () => {
    const t = program({
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: {
            fields: POLICY_FIELDS,
            defaultProject: 'PROJ',
            templates: {
              noted: { type: 'Bug', fields: { team: 'Web', notes: '**from** template' } },
            },
          },
        }),
      },
    });
    const create = ['jira', 'issue', 'create', '--type', 'Bug', '--summary', 'Broken login'];
    expect(
      await t.run([...create, '--field', 'team=web', '--field', 'notes=[x](https://example.test)'])
    ).toBe(0);
    expect(await t.run([...create, '--template', 'noted'])).toBe(0);
    expect(writes(t).map((w) => JSON.parse(w.bodyText ?? '').fields.customfield_10020)).toEqual([
      '[x|https://example.test]\n',
      '*from* template\n',
    ]);
  });

  it('takes Markdown for a wiki field on a transition', async () => {
    const t = policyProgram();
    expect(
      await t.run([
        'jira',
        'issue',
        'transition',
        'do',
        'PROJ-123',
        'start',
        '--field',
        'notes=**started**',
      ])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toMatchObject({
      transition: { id: '11' },
      fields: { customfield_10020: '*started*\n' },
    });
  });

  it('refuses under read-only mode before anything else', async () => {
    const t = policyProgram({ env: { LASSI_READ_ONLY: '1' } });
    expect(await t.run(update('--field', 'team=web'))).toBe(7);
    expect(t.fetch.calls).toHaveLength(0);
  });
});

describe('lassi jira issue update: edit metadata vetoes what Jira would refuse', () => {
  const editmetaWith = (fields: Record<string, unknown>): Route => ({
    path: '/rest/api/2/issue/PROJ-123/editmeta',
    json: { fields },
  });
  const TEAM = {
    name: 'Team',
    required: false,
    schema: { type: 'option' },
    allowedValues: [{ value: 'Platform' }, { value: 'Web' }],
  };

  it('refuses a field missing from the loaded edit metadata, with no PUT', async () => {
    const t = program();
    expect(await t.run(update('--field', 'team=web', '--field', 'priority=High'))).toBe(5);
    expect(writes(t)).toHaveLength(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: 'Jira does not let PROJ-123 be updated through priority: not on the edit screen',
      errors: { priority: 'not on the edit screen' },
      hint: 'Run `lassi jira issue editmeta PROJ-123` to see editable fields and allowed values.',
    });
  });

  it('refuses a field offered without the set operation, and a description missing from it', async () => {
    const t = program({
      routes: [editmetaWith({ customfield_10001: { ...TEAM, operations: ['add'] } })],
    });
    expect(await t.run(update('--field', 'team=web', '--body', 'New text'))).toBe(5);
    expect(writes(t)).toHaveLength(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message:
        'Jira does not let PROJ-123 be updated through team (customfield_10001), description: cannot be set (operations: add); not on the edit screen',
      errors: {
        customfield_10001: 'cannot be set (operations: add)',
        description: 'not on the edit screen',
      },
    });
  });

  it('says when the refusing metadata came from the cache', async () => {
    const t = program({ files: { [EDITMETA_CACHE]: cachedEditmeta('2026-09-04T09:00:00.000Z') } });
    expect(await t.run(update('--field', 'team=web', '--field', 'priority=High'))).toBe(5);
    expect(editmetaCalls(t)).toHaveLength(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      hint: 'The edit metadata was cached at 2026-09-04T09:00:00.000Z, possibly from another issue of the same project and type; run `lassi jira issue editmeta PROJ-123` to refresh it.',
    });
  });

  it('checks a fresh cache entry the --if-unchanged probe finds, without another request', async () => {
    const t = program({ files: { [EDITMETA_CACHE]: cachedEditmeta('2026-09-04T09:00:00.000Z') } });
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    await t.fs.writeFile(
      WORK,
      (await t.fs.readFile(WORK)).replace(
        'summary: Login page throws 500 on empty password',
        'summary: Edited'
      )
    );
    const before = t.fetch.calls.length;
    expect(await t.run(update('--file', 'work/PROJ-123.md', '--if-unchanged'))).toBe(5);
    expect(t.fetch.calls.slice(before).map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /rest/api/2/issue/PROJ-123',
    ]);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      errors: { summary: 'not on the edit screen' },
    });
  });

  it('still answers "no changes" without metadata when nothing changed', async () => {
    const t = program({ routes: [editmetaWith({})] });
    await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work/PROJ-123.md']);
    expect(await t.run(update('--file', 'work/PROJ-123.md', '--if-unchanged'))).toBe(0);
    expect(t.stdout()).toContain('no changes for PROJ-123\n');
    expect(editmetaCalls(t)).toHaveLength(0);
  });

  it('previews nothing under --dry-run when the veto applies', async () => {
    const t = program();
    expect(await t.run(['--dry-run', ...update('--field', 'priority=High')])).toBe(5);
    expect(writes(t)).toHaveLength(0);
    expect(t.stdout()).toBe('');
  });
});

describe('lassi jira issue transition list|do', () => {
  it('lists transitions with target status and screen fields', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'transition', 'list', 'PROJ-123'])).toBe(0);
    expect(t.stdout()).toContain('| 31 | Done | Done | resolution* |');
    expect(t.stdout()).toContain('| 11 | Start | In Progress |  |');
  });

  it('performs a transition with coerced screen fields and a converted comment', async () => {
    const t = program();
    expect(
      await t.run([
        'jira',
        'issue',
        'transition',
        'do',
        'PROJ-123',
        'done',
        '--field',
        'resolution=fixed',
        '--comment',
        '**done**',
      ])
    ).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: 'Fixed' } },
      update: { comment: [{ add: { body: '*done*\n' } }] },
    });
    expect(t.stdout()).toBe('PROJ-123: Done → Done\n');
  });

  it('accepts the id, previews with the sentence, and refuses missing screen fields', async () => {
    const dry = program();
    expect(
      await dry.run([
        'jira',
        'issue',
        'transition',
        'do',
        'PROJ-123',
        '31',
        '--field',
        'resolution=Fixed',
        '--dry-run',
      ])
    ).toBe(0);
    expect(dry.stdout()).toMatch(
      /^DRY RUN — nothing sent\nPOST \/rest\/api\/2\/issue\/PROJ-123\/transitions\nPROJ-123: Done → Done\n--- transition \(json\) ---\n/
    );
    expect(writes(dry)).toHaveLength(0);

    const missing = program();
    expect(await missing.run(['jira', 'issue', 'transition', 'do', 'PROJ-123', 'Done'])).toBe(5);
    expect(lastJsonLine(missing.stderr())).toMatchObject({
      code: 'validation',
      message: 'transition Done needs: resolution',
      errors: { resolution: 'Resolution is required.' },
      hint: 'Run `lassi jira issue transition list PROJ-123` to see the required screen fields.',
    });

    const value = program();
    expect(
      await value.run([
        'jira',
        'issue',
        'transition',
        'do',
        'PROJ-123',
        'Done',
        '--field',
        'resolution=Nope',
      ])
    ).toBe(5);
    expect(lastJsonLine(value.stderr())).toMatchObject({
      hint: expect.stringContaining('transition list PROJ-123'),
    });

    const unknown = program();
    expect(await unknown.run(['jira', 'issue', 'transition', 'do', 'PROJ-123', 'Fly'])).toBe(4);
    expect(lastJsonLine(unknown.stderr())).toMatchObject({
      code: 'not_found',
      message: 'no transition "Fly" on PROJ-123; available: Done (31), Start (11)',
    });
    expect([missing, value, unknown].flatMap((t) => writes(t))).toHaveLength(0);
  });
});

describe('lassi jira issue attach upload', () => {
  const files = { '/home/u/proj/shot.png': 'abc', '/home/u/proj/notes.txt': 'hello' };

  it('uploads each file as multipart and prints the results', async () => {
    const t = program({ files });
    expect(
      await t.run(['jira', 'issue', 'attach', 'upload', 'PROJ-123', 'shot.png', 'notes.txt'])
    ).toBe(0);
    const posts = writes(t);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['x-atlassian-token']).toBe('no-check');
    const part = posts[0]?.form?.get('file');
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe('shot.png');
    expect((part as Blob).type).toBe('image/png');
    const second = posts[1]?.form?.get('file');
    expect(second).toBeInstanceOf(Blob);
    expect((second as File).name).toBe('notes.txt');
    expect(t.stdout()).toContain('| shot.png | 77 | 3 | image/png |');
    expect(t.stdout().startsWith('uploaded 2 files to PROJ-123\n\n')).toBe(true);
  });

  it('checks every file before uploading anything', async () => {
    const missing = program({ files });
    expect(
      await missing.run(['jira', 'issue', 'attach', 'upload', 'PROJ-123', 'shot.png', 'nope.bin'])
    ).toBe(2);
    expect(lastJsonLine(missing.stderr())).toMatchObject({ message: 'file not found: nope.bin' });
    expect(missing.fetch.calls).toHaveLength(0);

    const big = program({
      files: {
        ...files,
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: {},
          attachments: { maxSizeMb: 0.000001 },
        }),
      },
    });
    expect(await big.run(['jira', 'issue', 'attach', 'upload', 'PROJ-123', 'shot.png'])).toBe(2);
    expect(lastJsonLine(big.stderr())).toMatchObject({
      message: expect.stringContaining('above attachments.maxSizeMb'),
    });
    expect(big.fetch.calls).toHaveLength(0);
  });

  it('--dry-run lists the files and sends nothing; read-only exits 7', async () => {
    const dry = program({ files });
    expect(
      await dry.run([
        'jira',
        'issue',
        'attach',
        'upload',
        'PROJ-123',
        'shot.png',
        'notes.txt',
        '--dry-run',
      ])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      'DRY RUN — nothing sent\nPOST /rest/api/2/issue/PROJ-123/attachments\n--- files (multipart) ---\nshot.png (3 B)\nnotes.txt (5 B)\n'
    );
    expect(dry.fetch.calls).toHaveLength(0);
    const ro = program({ files, env: { LASSI_READ_ONLY: 'yes' } });
    expect(await ro.run(['jira', 'issue', 'attach', 'upload', 'PROJ-123', 'shot.png'])).toBe(7);
    expect(ro.fetch.calls).toHaveLength(0);
  });

  it('stops at the first failed upload and says what already landed', async () => {
    const t = program({
      files,
      routes: [
        {
          method: 'POST',
          path: '/rest/api/2/issue/PROJ-123/attachments',
          times: 1,
          json: [{ id: '77', filename: 'shot.png', size: 3, mimeType: 'image/png' }],
        },
        {
          method: 'POST',
          path: '/rest/api/2/issue/PROJ-123/attachments',
          status: 413,
          text: 'too large',
        },
      ],
    });
    expect(
      await t.run(['jira', 'issue', 'attach', 'upload', 'PROJ-123', 'shot.png', 'notes.txt'])
    ).toBe(1);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'http',
      http: 413,
      message: expect.stringContaining('uploaded 1 of 2 files, then notes.txt failed'),
    });
  });
});

describe('lassi jira issue link create', () => {
  it('links with the outward phrase and flips for the inward phrase, printing the sentence', async () => {
    const outward = program();
    expect(
      await outward.run(['jira', 'issue', 'link', 'create', 'PROJ-1', 'PROJ-2', '--type', 'blocks'])
    ).toBe(0);
    expect(JSON.parse(writes(outward)[0]?.bodyText ?? '')).toEqual({
      type: { name: 'Blocks' },
      inwardIssue: { key: 'PROJ-1' },
      outwardIssue: { key: 'PROJ-2' },
    });
    expect(outward.stdout()).toBe('PROJ-1 blocks PROJ-2\n');

    const inward = program();
    expect(
      await inward.run([
        'jira',
        'issue',
        'link',
        'create',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'is blocked by',
        '--dry-run',
      ])
    ).toBe(0);
    expect(inward.stdout()).toBe(
      'DRY RUN — nothing sent\nPOST /rest/api/2/issueLink\nPROJ-1 is blocked by PROJ-2\n--- link (json) ---\n{\n  "type": {\n    "name": "Blocks"\n  },\n  "inwardIssue": {\n    "key": "PROJ-2"\n  },\n  "outwardIssue": {\n    "key": "PROJ-1"\n  }\n}\n'
    );
    expect(writes(inward)).toHaveLength(0);
  });

  it('reports unknown types and requires --type', async () => {
    const unknown = program();
    expect(
      await unknown.run([
        'jira',
        'issue',
        'link',
        'create',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'duplicates',
      ])
    ).toBe(4);
    expect(lastJsonLine(unknown.stderr())).toMatchObject({
      code: 'not_found',
      hint: expect.stringContaining('lassi jira link types'),
    });
    const none = program();
    expect(await none.run(['jira', 'issue', 'link', 'create', 'PROJ-1', 'PROJ-2'])).toBe(2);
    expect([unknown, none].flatMap((t) => writes(t))).toHaveLength(0);
  });
});

type StoredLink = {
  type: { id: string; name: string; inward: string; outward: string };
  source: string;
  target: string;
};

/**
 * A Jira that stores links the way Jira does. `POST /issueLink` makes `inwardIssue` the source of the
 * outward phrase ("inwardIssue blocks outwardIssue"). An issue's `issuelinks` then show the other end
 * as `outwardIssue` on the source and as `inwardIssue` on the target. Create and list agree only when
 * lassi sends what Jira expects; the fixtures above cannot tell.
 */
function linkingJira(): Route[] {
  const types = [
    { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '2', name: 'Issue split', inward: 'split from', outward: 'split to' },
    { id: '3', name: 'Relates', inward: 'relates to', outward: 'relates to' },
  ];
  const links = new Map<string, StoredLink>();
  let next = 100;
  const issue = (key: string) => ({
    id: key.slice(key.indexOf('-') + 1),
    key,
    fields: {
      issuelinks: [...links].flatMap(([id, l]): Array<Record<string, unknown>> => {
        if (l.source === key)
          return [{ id, type: l.type, outwardIssue: { id: '0', key: l.target } }];
        if (l.target === key)
          return [{ id, type: l.type, inwardIssue: { id: '0', key: l.source } }];
        return [];
      }),
    },
  });
  return [
    { path: '/rest/api/2/issueLinkType', json: { issueLinkTypes: types } },
    {
      method: 'POST',
      path: '/rest/api/2/issueLink',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as {
          type: { name: string };
          inwardIssue: { key: string };
          outwardIssue: { key: string };
        };
        const type = types.find((t) => t.name === body.type.name);
        if (!type) return { status: 404, json: { errorMessages: ['No issue link type'] } };
        links.set(String(next++), {
          type,
          source: body.inwardIssue.key,
          target: body.outwardIssue.key,
        });
        return { status: 201 };
      },
    },
    {
      method: 'DELETE',
      path: /^\/rest\/api\/2\/issueLink\/\d+$/,
      handler: (call) =>
        links.delete(call.url.pathname.split('/').pop() ?? '')
          ? { status: 204 }
          : { status: 404, json: { errorMessages: ['No issue link with that id'] } },
    },
    {
      method: 'GET',
      path: /^\/rest\/api\/2\/issue\/PROJ-[12](\?|$)/,
      handler: (call) => ({ json: issue(call.url.pathname.split('/').pop() ?? '') }),
    },
  ];
}

/** `link list KEY` as sentences, the way the table prints them. */
async function listed(routes: Route[], key: string): Promise<string[]> {
  const t = program({ routes });
  expect(await t.run(['jira', 'issue', 'link', 'list', key, '--json'])).toBe(0);
  const data = JSON.parse(t.stdout()) as {
    links: Array<{ description: string; otherKey: string }>;
  };
  return data.links.map((l) => `${key} ${l.description} ${l.otherKey}`);
}

describe("lassi jira issue link create|delete against Jira's link semantics", () => {
  it('creates the link it prints, seen the same way from both issues', async () => {
    const jira = linkingJira();
    const t = program({ routes: jira });
    expect(
      await t.run(['jira', 'issue', 'link', 'create', 'PROJ-1', 'PROJ-2', '--type', 'split to'])
    ).toBe(0);
    expect(t.stdout()).toBe('PROJ-1 split to PROJ-2\n');
    expect(await listed(jira, 'PROJ-1')).toEqual(['PROJ-1 split to PROJ-2']);
    expect(await listed(jira, 'PROJ-2')).toEqual(['PROJ-2 split from PROJ-1']);

    const flipped = linkingJira();
    expect(
      await program({ routes: flipped }).run([
        'jira',
        'issue',
        'link',
        'create',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'split from',
      ])
    ).toBe(0);
    expect(await listed(flipped, 'PROJ-1')).toEqual(['PROJ-1 split from PROJ-2']);
  });

  it('deletes the link named by either issue, and only that one', async () => {
    const jira = linkingJira();
    await program({ routes: jira }).run([
      'jira',
      'issue',
      'link',
      'create',
      'PROJ-1',
      'PROJ-2',
      '--type',
      'blocks',
    ]);
    await program({ routes: jira }).run([
      'jira',
      'issue',
      'link',
      'create',
      'PROJ-1',
      'PROJ-2',
      '--type',
      'split to',
    ]);
    const t = program({ routes: jira });
    expect(
      await t.run(['jira', 'issue', 'link', 'delete', 'PROJ-2', 'PROJ-1', '--type', 'split from'])
    ).toBe(0);
    expect(t.stdout()).toBe('deleted link: PROJ-2 split from PROJ-1\n');
    expect(await listed(jira, 'PROJ-1')).toEqual(['PROJ-1 blocks PROJ-2']);
  });

  it('deletes a symmetric link as listed, whichever way Jira stored it', async () => {
    const jira = linkingJira();
    await program({ routes: jira }).run([
      'jira',
      'issue',
      'link',
      'create',
      'PROJ-2',
      'PROJ-1',
      '--type',
      'relates to',
    ]);
    expect(await listed(jira, 'PROJ-1')).toEqual(['PROJ-1 relates to PROJ-2']);
    const t = program({ routes: jira });
    expect(
      await t.run(['jira', 'issue', 'link', 'delete', 'PROJ-1', 'PROJ-2', '--type', 'relates to'])
    ).toBe(0);
    expect(await listed(jira, 'PROJ-1')).toEqual([]);
  });

  it('repairs a link created the wrong way round, naming it when the phrase does not match', async () => {
    const jira = linkingJira();
    // What earlier versions stored for `link create PROJ-1 PROJ-2 --type "split to"`.
    await program({ routes: jira }).run([
      'jira',
      'issue',
      'link',
      'create',
      'PROJ-1',
      'PROJ-2',
      '--type',
      'split from',
    ]);
    const miss = program({ routes: jira });
    expect(
      await miss.run(['jira', 'issue', 'link', 'delete', 'PROJ-1', 'PROJ-2', '--type', 'split to'])
    ).toBe(4);
    expect(lastJsonLine(miss.stderr())).toMatchObject({
      code: 'not_found',
      message: 'no link PROJ-1 split to PROJ-2',
      hint: 'PROJ-1 and PROJ-2 are linked as: PROJ-1 split from PROJ-2; pass that phrase to --type',
    });
    expect(
      await program({ routes: jira }).run([
        'jira',
        'issue',
        'link',
        'delete',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'split from',
      ])
    ).toBe(0);
    expect(
      await program({ routes: jira }).run([
        'jira',
        'issue',
        'link',
        'create',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'split to',
      ])
    ).toBe(0);
    expect(await listed(jira, 'PROJ-1')).toEqual(['PROJ-1 split to PROJ-2']);
  });

  it('previews a delete, and refuses it under read-only, for a self link or an unknown type', async () => {
    const jira = linkingJira();
    await program({ routes: jira }).run([
      'jira',
      'issue',
      'link',
      'create',
      'PROJ-1',
      'PROJ-2',
      '--type',
      'blocks',
    ]);
    const dry = program({ routes: jira });
    expect(
      await dry.run([
        'jira',
        'issue',
        'link',
        'delete',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'blocks',
        '--dry-run',
      ])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      'DRY RUN — nothing sent\nDELETE /rest/api/2/issueLink/100\n--- link ---\n100: PROJ-1 blocks PROJ-2\n'
    );
    const readOnly = program({ routes: jira, env: { LASSI_READ_ONLY: '1' } });
    expect(
      await readOnly.run([
        'jira',
        'issue',
        'link',
        'delete',
        'PROJ-1',
        'PROJ-2',
        '--type',
        'blocks',
      ])
    ).toBe(7);
    const self = program({ routes: jira });
    expect(
      await self.run(['jira', 'issue', 'link', 'delete', 'PROJ-1', 'PROJ-1', '--type', 'blocks'])
    ).toBe(2);
    const unknown = program({ routes: jira });
    expect(
      await unknown.run(['jira', 'issue', 'link', 'delete', 'PROJ-1', 'PROJ-2', '--type', 'clones'])
    ).toBe(4);
    expect([dry, readOnly, self, unknown].flatMap((t) => writes(t))).toHaveLength(0);
    expect(await listed(jira, 'PROJ-1')).toEqual(['PROJ-1 blocks PROJ-2']);
  });
});

describe('"." as the issue key on writes', () => {
  it('resolves the branch key before the dry-run preview', async () => {
    const t = program({ files: { '/home/u/proj/.git/HEAD': 'ref: refs/heads/fix/PROJ-123-x\n' } });
    expect(
      await t.run(['jira', 'issue', 'comment', 'add', '.', '--body', 'one line', '--dry-run'])
    ).toBe(0);
    expect(t.stdout()).toContain('POST /rest/api/2/issue/PROJ-123/comment\n');
  });

  it('refuses to link an issue to itself', async () => {
    const t = program({ files: { '/home/u/proj/.git/HEAD': 'ref: refs/heads/fix/PROJ-123-x\n' } });
    expect(
      await t.run(['jira', 'issue', 'link', 'create', '.', 'PROJ-123', '--type', 'blocks'])
    ).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: 'cannot link PROJ-123 to itself',
    });
    expect(t.fetch.calls).toHaveLength(0);
  });
});

describe('lassi jira issue create --template', () => {
  const files = {
    '/home/u/proj/.lassi.json': JSON.stringify({
      jira: {
        fields: { team: 'customfield_10001' },
        defaultProject: 'PROJ',
        templates: {
          bug: {
            type: 'Bug',
            fields: { team: 'Web', labels: 'a,b' },
            descriptionFile: 'templates/bug.md',
          },
          bare: { summary: 'From template', description: 'inline body' },
          titled: { type: 'Bug', fields: { team: 'Web', summary: 'From fields' } },
          stale: { type: 'Bug', fields: { team: 'Retired' } },
        },
      },
    }),
    '/home/u/proj/templates/bug.md': '## Steps\n\n1. one\n',
  };
  const create = ['jira', 'issue', 'create'];

  it('merges type, fields and the description file, with flags winning', async () => {
    const t = program({ files });
    expect(await t.run([...create, '--template', 'bug', '--summary', 'Broken login'])).toBe(0);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: {
        customfield_10001: { value: 'Web' },
        labels: ['a', 'b'],
        project: { key: 'PROJ' },
        issuetype: { name: 'Bug' },
        summary: 'Broken login',
        description: 'h2. Steps\n\n# one\n',
      },
    });
    const flags = program({ files });
    expect(
      await flags.run([
        ...create,
        '--template',
        'bug',
        '--summary',
        'S',
        '--field',
        'team=Platform',
        '--body',
        'own text',
      ])
    ).toBe(0);
    expect(JSON.parse(writes(flags)[0]?.bodyText ?? '')).toMatchObject({
      fields: { customfield_10001: { value: 'Platform' }, description: 'own text\n' },
    });
    const bare = program({ files });
    expect(
      await bare.run([
        ...create,
        '--template',
        'bare',
        '--type',
        'Bug',
        '--field',
        'team=Web',
        '--dry-run',
      ])
    ).toBe(0);
    expect(bare.stdout()).toContain('"summary": "From template"');
    expect(bare.stdout()).toContain('"description": "inline body\\n"');
    expect(writes(bare)).toHaveLength(0);
    const titled = program({ files });
    expect(
      await titled.run([...create, '--template', 'titled', '--summary', 'Mine', '--dry-run'])
    ).toBe(0);
    expect(titled.stdout()).toContain('"summary": "Mine"');
    const untitled = program({ files });
    expect(await untitled.run([...create, '--template', 'titled', '--dry-run'])).toBe(0);
    expect(untitled.stdout()).toContain('"summary": "From fields"');
    // A stale template value is replaced by the override before it is ever coerced.
    const stale = program({ files });
    expect(
      await stale.run([
        ...create,
        '--template',
        'stale',
        '--summary',
        'S',
        '--field',
        'team=Web',
        '--dry-run',
      ])
    ).toBe(0);
    expect(stale.stdout()).toContain('"value": "Web"');
    const unfixed = program({ files });
    expect(await unfixed.run([...create, '--template', 'stale', '--summary', 'S'])).toBe(5);
    expect(lastJsonLine(unfixed.stderr())).toMatchObject({
      errorsByAlias: { team: 'Allowed: Platform, Web' },
    });
  });

  it('treats a damaged cache as no record rather than an internal failure', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-123', '--out', 'work.md'])).toBe(0);
    await t.fs.writeFile('/home/u/proj/.lassi/cache/jira/PROJ-123.json', '{"files":');
    // A JSON parser message on stderr with exit 1 told the user nothing; the usage error names the
    // command that rebuilds the record.
    expect(await t.run(['jira', 'issue', 'update', 'PROJ-123', '--file', 'work.md'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('no record of work.md'),
      hint: expect.stringContaining('is not valid JSON'),
    });
    // One human line and one JSON line, not three: the damaged-cache detail rides on the hint.
    expect(t.stderr().trimEnd().split('\n')).toHaveLength(2);
  });

  it('rejects an unknown template and an unreadable description file before any request', async () => {
    const unknown = program({ files });
    expect(await unknown.run([...create, '--template', 'nope', '--summary', 'S'])).toBe(2);
    expect(lastJsonLine(unknown.stderr())).toMatchObject({
      code: 'usage',
      message: 'unknown template "nope"; configured: bug, bare, titled, stale',
      hint: expect.stringContaining('lassi jira templates'),
    });
    expect(unknown.fetch.calls).toHaveLength(0);
    const missing = program({
      files: { '/home/u/proj/.lassi.json': files['/home/u/proj/.lassi.json'] },
    });
    expect(await missing.run([...create, '--template', 'bug', '--summary', 'S'])).toBe(2);
    expect(lastJsonLine(missing.stderr())).toMatchObject({
      message: expect.stringContaining('cannot read /home/u/proj/templates/bug.md'),
    });
    expect(missing.fetch.calls).toHaveLength(0);
  });
});
