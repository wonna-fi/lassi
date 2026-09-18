import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { nodeFs } from './node.js';

it('exclusive files prevent another process from acquiring the same lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-exclusive-'));
  const path = join(dir, 'lock');
  const fs = nodeFs();
  const exec = promisify(execFile);
  const child = () =>
    exec(process.execPath, [
      '-e',
      "require('node:fs').closeSync(require('node:fs').openSync(process.argv[1], 'wx'))",
      path,
    ]);
  try {
    await fs.writeFileExclusive(path, 'owner');
    await expect(child()).rejects.toMatchObject({ stderr: expect.stringContaining('EEXIST') });
    expect(await fs.readFile(path)).toBe('owner');
    await fs.unlink(path);
    await child();
    await expect(fs.writeFileExclusive(path, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await fs.readFile(path)).toBe('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
