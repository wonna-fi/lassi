import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from './test/program.js';

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

  it('help <command> prints that command help; unknown → 2', async () => {
    const t = makeTestProgram();
    expect(await t.run(['help', 'config', 'show'])).toBe(0);
    expect(t.stdout()).toContain('Usage: lassi config show');
    const bad = makeTestProgram();
    expect(await bad.run(['help', 'nope'])).toBe(2);
  });
});
