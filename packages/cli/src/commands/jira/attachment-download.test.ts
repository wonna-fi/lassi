import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-download-'));
  dirs.push(dir);
  return dir;
}
function program(names = ['screenshot.png', 'screenshot.png'], failure = false) {
  return makeTestProgram({
    env: BOTH_PRODUCTS_ENV,
    routes: [
      {
        path: '/rest/api/2/issue/PROJ-1',
        json: {
          fields: {
            attachment: names.map((filename, i) => ({
              id: String(i + 1),
              filename,
              size: 3,
              mimeType: 'image/png',
              content: `https://jira.example.internal/download/${i + 1}`,
            })),
          },
        },
      },
      { path: '/download/1', bytes: new Uint8Array([1, 1, 1]) },
      failure
        ? {
            path: '/download/2',
            status: 404,
            json: {
              errorMessages: ['attachment missing', 'second detail'],
              errors: { attachment: 'not available' },
            },
          }
        : { path: '/download/2', bytes: new Uint8Array([2, 2, 2]) },
    ],
  });
}
const args = (dir: string) => ['jira', 'attach', 'get', 'PROJ-1', '--out', dir, '--json'];

describe('Jira attachment identity and batch results', () => {
  it('preserves both same-name files and returns their ID-to-path mapping', async () => {
    const dir = await directory();
    const p = program();
    expect(await p.run(args(dir))).toBe(0);
    const result = JSON.parse(p.stdout());
    expect(result).toMatchObject({ saved: 2, failed: 0, complete: true });
    expect(result.files).toMatchObject([
      { id: '1', file: 'screenshot.png', status: 'saved' },
      { id: '2', file: 'screenshot.png', status: 'saved' },
    ]);
    expect(result.files[0].path).not.toBe(result.files[1].path);
    expect(await readFile(join(dir, '1-screenshot.png'))).toEqual(Buffer.from([1, 1, 1]));
    expect(await readFile(join(dir, '2-screenshot.png'))).toEqual(Buffer.from([2, 2, 2]));
  });

  it('reports identical repeat downloads as unchanged and keeps modified files', async () => {
    const dir = await directory();
    expect(await program().run(args(dir))).toBe(0);
    const repeat = program();
    expect(await repeat.run(args(dir))).toBe(0);
    expect(JSON.parse(repeat.stdout())).toMatchObject({ saved: 0, unchanged: 2, complete: true });
    await writeFile(join(dir, '1-screenshot.png'), 'edit');
    const edited = program();
    expect(await edited.run(args(dir))).toBe(6);
    expect(JSON.parse(edited.stdout())).toMatchObject({ failed: 1, unchanged: 1, complete: false });
    expect(lastJsonLine(edited.stderr())).toMatchObject({ code: 'conflict' });
    expect(await readFile(join(dir, '1-screenshot.png'), 'utf8')).toBe('edit');
    expect(await readdir(dir)).toEqual(['1-screenshot.png', '2-screenshot.png']);
  });

  it('keeps names distinct after sanitization and writes within the output directory', async () => {
    const dir = await directory();
    const p = program(['../a.png', '..\\a.png']);
    expect(await p.run(args(dir))).toBe(0);
    const result = JSON.parse(p.stdout());
    expect(result.files.map((r: { file: string }) => r.file)).toEqual(['../a.png', '..\\a.png']);
    expect(await readdir(dir)).toEqual(['1-__a.png', '2-__a.png']);
  });

  it('saves long ASCII and Unicode names within the byte limit without losing their extension', async () => {
    const dir = await directory();
    const p = program(['a'.repeat(251) + '.png', 'ä'.repeat(125) + '.png']);
    expect(await p.run(args(dir))).toBe(0);
    for (const row of JSON.parse(p.stdout()).files) {
      const name = basename(row.path);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(name).toMatch(/^[12]-.*\.png$/);
      expect(name).not.toContain('�');
      expect(await readFile(join(dir, name))).toHaveLength(3);
    }
  });

  it('returns successful paths and a structured error for mixed success and failure', async () => {
    const dir = await directory();
    const p = program(undefined, true);
    expect(await p.run(args(dir))).toBe(4);
    expect(JSON.parse(p.stdout())).toMatchObject({
      saved: 1,
      failed: 1,
      complete: false,
      files: [
        { status: 'saved' },
        { id: '2', status: 'failed', error: { code: 'not_found', http: 404 } },
      ],
    });
    expect(lastJsonLine(p.stderr())).toMatchObject({
      code: 'not_found',
      errorMessages: ['attachment missing', 'second detail'],
      http: 404,
      errors: { attachment: 'not available' },
      request: { method: 'GET', url: '/download/2' },
    });
    expect(p.fetch.unmatched).toEqual([]);
  });

  it('reports size exclusions without claiming the batch is complete', async () => {
    const dir = await directory();
    const p = program();
    expect(await p.run([...args(dir), '--max-size', '0.000001'])).toBe(0);
    expect(JSON.parse(p.stdout())).toMatchObject({
      saved: 0,
      skipped: 2,
      failed: 0,
      complete: false,
    });
    expect(p.fetch.calls).toHaveLength(1);
  });
});
