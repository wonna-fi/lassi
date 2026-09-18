import { describe, expect, it } from 'vitest';
import { makeTestProgram } from '../test/program.js';
import { readBodyInput } from './body.js';

describe('readBodyInput', () => {
  it('prefers --body, then --file, then piped stdin for a required body', async () => {
    const t = makeTestProgram({
      files: { '/home/u/proj/note.md': '# from file\n' },
      stdin: '# from stdin\n',
    });
    expect(await readBodyInput(t.deps, { body: 'inline' }, { required: true })).toBe('inline');
    expect(await readBodyInput(t.deps, { file: 'note.md' }, { required: true })).toBe(
      '# from file\n'
    );
    expect(await readBodyInput(t.deps, {}, { required: true })).toBe('# from stdin\n');
    expect(await readBodyInput(t.deps, { file: '-' }, { required: false })).toBe('# from stdin\n');
  });

  it('never reads an open stdin for an optional body unless --file - asks for it', async () => {
    const t = makeTestProgram({ stdin: 'data' });
    expect(await readBodyInput(t.deps, {}, { required: false })).toBeUndefined();
  });

  it('rejects both flags, unreadable files and a terminal without input', async () => {
    const t = makeTestProgram();
    await expect(
      readBodyInput(t.deps, { body: 'a', file: 'b' }, { required: true })
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      readBodyInput(t.deps, { file: 'missing.md' }, { required: true })
    ).rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('missing.md') });
    await expect(readBodyInput(t.deps, {}, { required: true })).rejects.toMatchObject({
      code: 'usage',
    });
    expect(await readBodyInput(t.deps, {}, { required: false })).toBeUndefined();
  });
});
