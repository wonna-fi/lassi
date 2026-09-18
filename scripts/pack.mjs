import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, 'artifacts'), { recursive: true });
// Invoke npm through Node so the same command works with Windows npm.cmd installations.
execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'pack', './release', '--pack-destination', './artifacts'],
  {
    cwd: root,
    stdio: 'inherit',
  }
);
