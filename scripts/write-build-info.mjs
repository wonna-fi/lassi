// Writes packages/cli/build-info.json after `tsc -b` so `lassi --version` can print the git SHA and
// `lassi doctor` can detect a stale build (dist older than the newest source file).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = join(root, 'packages', 'cli');
const { version } = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));

let sha = 'nogit';
let commit;
let dirty = true;
try {
  if (!existsSync(join(root, '.git'))) throw new Error('No repository metadata');
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  dirty =
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // not a git checkout (e.g. an exported tarball); keep the placeholder
}

const info = { version, sha, commit, dirty, builtAt: new Date().toISOString() };
writeFileSync(join(cliDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: lassi ${version} (${sha})`);
