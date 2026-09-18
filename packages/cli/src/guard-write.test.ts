import { describe, expect, it } from 'vitest';
import { isReadOnly } from './guard-write.js';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from './test/program.js';

const SKILL_FILES = { '/repo/skills/jira/SKILL.md': '---\nname: jira\n---\n# Jira\n' };

describe('isReadOnly', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['anything', true],
  ])('LASSI_READ_ONLY=%j → %s', (value, expected) => {
    expect(isReadOnly(value === undefined ? {} : { LASSI_READ_ONLY: value })).toBe(expected);
  });
});

describe('write commands under LASSI_READ_ONLY', () => {
  it('exit 7 before doing anything, with the env var named in the hint', async () => {
    const t = makeTestProgram({ env: { LASSI_READ_ONLY: '1' }, files: SKILL_FILES });
    expect(await t.run(['skills', 'install'])).toBe(7);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'read_only',
      hint: 'LASSI_READ_ONLY is set; unset it to allow writes (--dry-run is still allowed).',
    });
    expect(t.fetch.calls).toHaveLength(0);
    expect([...t.fs.files.keys()].some((p) => p.startsWith('/home/u/.agents'))).toBe(false);
  });

  it('redacts the preview, so a token in the payload never reaches stdout', async () => {
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: [{ path: '/rest/api/2/issue/PROJ-1', json: { key: 'PROJ-1', fields: {} } }],
    });
    const body = 'rotate jira-secret-token today';
    expect(await t.run(['jira', 'comment', 'add', 'PROJ-1', '--body', body, '--dry-run'])).toBe(0);
    expect(t.stdout()).toContain('DRY RUN — nothing sent');
    expect(t.stdout()).not.toContain('jira-secret-token');
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('--dry-run is still allowed and writes nothing', async () => {
    const t = makeTestProgram({ env: { LASSI_READ_ONLY: '1' }, files: SKILL_FILES });
    expect(await t.run(['skills', 'install', '--dry-run'])).toBe(0);
    expect(t.stdout()).toMatch(/^DRY RUN — nothing sent\nPUT /);
    expect(t.stdout()).toContain('jira/SKILL.md');
    expect([...t.fs.files.keys()].some((p) => p.startsWith('/home/u/.agents'))).toBe(false);
  });

  it('--dry-run with --json prints one document', async () => {
    const t = makeTestProgram({ files: SKILL_FILES });
    expect(await t.run(['skills', 'install', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout())).toMatchObject({
      dryRun: true,
      destRoot: '/home/u/.agents/skills',
    });
  });
});
