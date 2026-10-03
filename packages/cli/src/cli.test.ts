import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from './test/program.js';

const MOVED_COMMANDS = [
  { oldPath: 'jira comment list', path: 'jira issue comment list' },
  { oldPath: 'jira comment add', path: 'jira issue comment add' },
  { oldPath: 'jira comment edit', path: 'jira issue comment edit' },
  { oldPath: 'jira comment delete', path: 'jira issue comment delete' },
  { oldPath: 'jira attach get', path: 'jira issue attach get' },
  { oldPath: 'jira attach upload', path: 'jira issue attach upload' },
  { oldPath: 'jira transition list', path: 'jira issue transition list' },
  { oldPath: 'jira transition do', path: 'jira issue transition do' },
  { oldPath: 'jira link list', path: 'jira issue link list' },
  { oldPath: 'jira link create', path: 'jira issue link create' },
  { oldPath: 'jira link delete', path: 'jira issue link delete' },
  { oldPath: 'jira component list', path: 'jira project component list' },
  { oldPath: 'jira component create', path: 'jira project component create' },
  { oldPath: 'jira version list', path: 'jira project version list' },
  { oldPath: 'confluence comment list', path: 'confluence page comment list' },
  { oldPath: 'confluence comment add', path: 'confluence page comment add' },
  { oldPath: 'confluence attach get', path: 'confluence page attach get' },
];

describe('program', () => {
  it('prints version with the git sha', async () => {
    const t = makeTestProgram();
    expect(await t.run(['--version'])).toBe(0);
    expect(t.stdout()).toBe('lassi 0.0.0-test (testsha)\n');
  });

  it('root help lists namespaces and cross-cutting commands only', async () => {
    const t = makeTestProgram();
    expect(await t.run(['--help'])).toBe(0);
    const help = t.stdout();
    expect(help).toContain('jira');
    expect(help).toContain('confluence|conf');
    expect(help).toContain('doctor');
    expect(help).toContain('config');
    expect(help).toContain('skills');
    expect(help).toContain('--dry-run');
  });

  it('turns an unknown option into exit 2 with the JSON contract line', async () => {
    const t = makeTestProgram();
    expect(await t.run(['doctor', '--bogus'])).toBe(2);
    expect(t.stderr()).toMatch(/^error: unknown option '--bogus'/);
    expect(lastJsonLine(t.stderr())).toEqual({
      code: 'usage',
      message: "unknown option '--bogus'",
    });
    expect(t.stdout()).toBe('');
  });

  it('rejects excess arguments', async () => {
    const t = makeTestProgram();
    expect(await t.run(['doctor', 'extra'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'usage' });
  });

  it('accepts global flags before and after the command', async () => {
    const before = makeTestProgram({ env: BOTH_PRODUCTS_ENV });
    await before.run(['--json', 'config', 'show']);
    const after = makeTestProgram({ env: BOTH_PRODUCTS_ENV });
    await after.run(['config', 'show', '--json']);
    expect(before.stdout()).toBe(after.stdout());
    const doc = JSON.parse(before.stdout()) as { config: Record<string, unknown> };
    expect(doc.config['jira.url']).toBe('https://jira.example.internal');
  });

  it.each(['jira issue comment list PROJ-1', 'confluence page comment list 123'])(
    '%s accepts global flags on either side',
    async (command) => {
      const options = {
        env: BOTH_PRODUCTS_ENV,
        routes: [
          {
            path: '/rest/api/2/issue/PROJ-1/comment',
            json: { comments: [], total: 0, startAt: 0, maxResults: 50 },
          },
          { path: '/rest/api/content/123/child/comment', json: { results: [], size: 0 } },
        ],
      };
      const args = command.split(' ');
      const before = makeTestProgram(options);
      const after = makeTestProgram(options);
      expect(await before.run(['--json', ...args])).toBe(0);
      expect(await after.run([...args, '--json'])).toBe(0);
      expect(before.stdout()).toBe(after.stdout());
      expect(before.fetch.calls).toHaveLength(1);
      expect(after.fetch.calls).toHaveLength(1);
    }
  );

  it('conf resolves a nested page command identically to confluence', async () => {
    const options = {
      env: BOTH_PRODUCTS_ENV,
      routes: [{ path: '/rest/api/content/123/child/comment', json: { results: [], size: 0 } }],
    };
    const args = ['page', 'comment', 'list', '123', '--json'];
    const canonical = makeTestProgram(options);
    const alias = makeTestProgram(options);
    expect(await canonical.run(['confluence', ...args])).toBe(0);
    expect(await alias.run(['conf', ...args])).toBe(0);
    expect(alias.stdout()).toBe(canonical.stdout());
    expect(alias.fetch.calls.map((call) => call.url.href)).toEqual(
      canonical.fetch.calls.map((call) => call.url.href)
    );
  });

  it('help --all renders the whole tree as markdown with global options once', async () => {
    const t = makeTestProgram();
    expect(await t.run(['help', '--all'])).toBe(0);
    const md = t.stdout();
    expect(md).toContain('# lassi command reference');
    expect(md).toContain('#### lassi doctor');
    expect(md).toContain('#### lassi config show');
    expect(md).toContain('#### lassi skills install');
    expect(md).toContain('## lassi jira');
    expect(md.split('--dry-run').length - 1).toBe(1);
  });

  it('help --all nests operations beneath their owning resources', async () => {
    const t = makeTestProgram();
    expect(await t.run(['help', '--all'])).toBe(0);
    const headings = t
      .stdout()
      .split('\n')
      .filter((l) => /^#+ lassi /.test(l))
      .map((l) => l.replace(/ — .*/, ''));
    expect(headings).toEqual(
      expect.arrayContaining([
        '### lassi jira issue',
        '#### lassi jira issue update',
        '#### lassi jira issue component',
        '##### lassi jira issue component add',
        '##### lassi jira issue component remove',
        '#### lassi jira issue export',
        '### lassi jira project',
        '#### lassi jira project component',
        '#### lassi jira project version',
        '#### lassi jira link types',
        '### lassi confluence page',
        '#### lassi confluence comment delete',
      ])
    );
    for (const { oldPath, path } of MOVED_COMMANDS) {
      expect(headings).toContain(`##### lassi ${path}`);
      expect(headings.some((heading) => heading.endsWith(` lassi ${oldPath}`))).toBe(false);
    }
  });

  it.each(MOVED_COMMANDS)('both help forms resolve $path without I/O', async ({ path }) => {
    const direct = makeTestProgram();
    const help = makeTestProgram();
    expect(await direct.run([...path.split(' '), '--help'])).toBe(0);
    expect(await help.run(['help', ...path.split(' ')])).toBe(0);
    expect(direct.stdout()).toContain(`Usage: lassi ${path}`);
    expect(help.stdout()).toBe(direct.stdout());
    expect(direct.fetch.calls).toHaveLength(0);
    expect(help.fetch.calls).toHaveLength(0);
  });

  it.each(MOVED_COMMANDS)('rejects the removed path $oldPath before I/O', async ({ oldPath }) => {
    const t = makeTestProgram({ env: BOTH_PRODUCTS_ENV });
    expect(await t.run(oldPath.split(' '))).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'usage' });
    expect(t.stderr()).toContain('unknown command');
    expect(t.stdout()).toBe('');
    expect(t.fetch.calls).toHaveLength(0);
  });

  it.each([
    {
      path: 'jira',
      children: ['issue', 'project', 'link', 'fields', 'templates', 'digest'],
      absent: ['comment', 'attach', 'transition', 'component', 'version'],
    },
    {
      path: 'jira issue',
      children: ['get', 'component', 'fix-version', 'comment', 'attach', 'transition', 'link'],
      absent: ['project'],
    },
    { path: 'jira project', children: ['component', 'version'], absent: ['issue'] },
    {
      path: 'confluence',
      children: ['page', 'comment', 'search', 'tree', 'stats'],
      absent: ['attach'],
    },
    {
      path: 'confluence page',
      children: ['get', 'create', 'update', 'validate', 'export', 'comment', 'attach'],
      absent: ['search', 'tree'],
    },
    { path: 'confluence comment', children: ['delete'], absent: ['list', 'add'] },
  ])('$path help exposes its resources', async ({ path, children, absent }) => {
    const t = makeTestProgram();
    expect(await t.run(['help', ...path.split(' ')])).toBe(0);
    for (const name of children) expect(t.stdout()).toMatch(new RegExp(`^  ${name}(?:\\s|$)`, 'm'));
    for (const name of absent)
      expect(t.stdout()).not.toMatch(new RegExp(`^  ${name}(?:\\s|$)`, 'm'));
  });

  it.each([
    'jira link types',
    'jira fields',
    'jira templates',
    'jira digest',
    'confluence search',
    'confluence tree',
    'confluence stats macros',
    'confluence comment delete',
  ])('keeps the broader command %s available', async (path) => {
    const t = makeTestProgram();
    expect(await t.run(['help', ...path.split(' ')])).toBe(0);
    expect(t.stdout()).toContain(`Usage: lassi ${path}`);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('help <command> prints that command help; unknown → 2', async () => {
    const t = makeTestProgram();
    expect(await t.run(['help', 'config', 'show'])).toBe(0);
    expect(t.stdout()).toContain('Usage: lassi config show');
    const bad = makeTestProgram();
    expect(await bad.run(['help', 'nope'])).toBe(2);
  });
});
