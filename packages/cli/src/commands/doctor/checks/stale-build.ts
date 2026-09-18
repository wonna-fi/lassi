import { pathApi, type LassiFs } from '@wonna/lassi-core';
import type { Check, CheckResult } from '../types.js';

export interface NewestFile {
  path: string;
  mtimeMs: number;
}

async function walk(fs: LassiFs, dir: string, out: { newest?: NewestFile }): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = pathApi(dir).join(dir, name);
    const stat = await fs.stat(path);
    if (stat.isDirectory) {
      await walk(fs, path, out);
    } else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) {
      if (!out.newest || stat.mtimeMs > out.newest.mtimeMs)
        out.newest = { path, mtimeMs: stat.mtimeMs };
    }
  }
}

// Newest non-test source file under every package src dir (git pull touches mtimes, so this catches pull-without-build).
export async function newestSourceMtime(
  fs: LassiFs,
  repoRoot: string
): Promise<NewestFile | undefined> {
  const out: { newest?: NewestFile } = {};
  const api = pathApi(repoRoot);
  const packages = api.join(repoRoot, 'packages');
  // Every workspace package, read from disk: a hard-coded list silently stops covering the next
  // package added, and reports an all-clear on exactly the pull-without-build case this catches.
  let names: string[];
  try {
    names = await fs.readdir(packages);
  } catch {
    return undefined;
  }
  for (const pkg of names) {
    await walk(fs, api.join(packages, pkg, 'src'), out);
  }
  return out.newest;
}

export function staleBuildStatus(
  builtAt: string | undefined,
  newest: NewestFile | undefined
): CheckResult {
  const name = 'Build freshness';
  if (builtAt === undefined) {
    return { name, status: 'WARN', detail: 'no build-info.json', hint: 'run `npm run build`' };
  }
  const built = Date.parse(builtAt);
  if (Number.isNaN(built))
    return { name, status: 'WARN', detail: `unreadable builtAt: ${builtAt}` };
  if (newest && newest.mtimeMs > built) {
    return {
      name,
      status: 'WARN',
      detail: `${newest.path} is newer than the build (${builtAt})`,
      hint: 'run `npm run build` after `git pull`',
    };
  }
  return { name, status: 'PASS', detail: `built ${builtAt}` };
}

export const staleBuildCheck: Check = async (ctx) => {
  const newest = await newestSourceMtime(ctx.deps.fs, ctx.deps.repoRoot);
  return [staleBuildStatus(ctx.deps.buildInfo.builtAt, newest)];
};
