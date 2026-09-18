import { LassiError, pathApi, type LassiFs } from '@wonna/lassi-core';
import type { Context } from '../../context.js';
import { isExportCandidate } from './export-manifest.js';

export const STORAGE_LOCK = '.lassi-write.lock';

function storageBusy(lock: string): LassiError {
  return new LassiError('conflict', `another lassi operation holds ${lock}`, {
    hint: 'retry after that operation finishes; if it was interrupted, remove this lock only after confirming no process is using this directory',
  });
}

/** Readers must not interpret a writer's intermediate data files as a damaged index. */
export async function assertStorageIdle(fs: LassiFs, dir: string): Promise<void> {
  const lock = pathApi(dir).join(dir, STORAGE_LOCK);
  if (await fs.exists(lock)) throw storageBusy(lock);
}

/** Exclusive file creation works across processes and through directory symlinks. */
export async function withStorageLock<T>(
  ctx: Context,
  dir: string,
  run: () => Promise<T>,
  opts: { dryRun?: boolean } = {}
): Promise<T> {
  if (opts.dryRun) return run();
  const fs = ctx.deps.fs;
  const lock = pathApi(dir).join(dir, STORAGE_LOCK);
  try {
    await fs.writeFileExclusive(
      lock,
      JSON.stringify({ startedAt: ctx.deps.now().toISOString() }) + '\n'
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw storageBusy(lock);
  }
  try {
    return await run();
  } finally {
    await fs.unlink(lock);
  }
}

/** Resolve existing ancestors too: the index's final directory need not exist yet. */
async function canonical(fs: LassiFs, path: string): Promise<string> {
  const api = pathApi(path);
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      return api.join(await fs.realpath(current), ...suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = api.dirname(current);
      if (parent === current) return path;
      suffix.unshift(api.basename(current));
      current = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  if (pathApi(parent) !== pathApi(child)) return false;
  const api = pathApi(parent);
  const relative = api.relative(parent, child);
  return (
    relative === '' ||
    (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`))
  );
}

/** Index publication must never overwrite an archive or another source manifest. */
export async function assertIndexTarget(
  fs: LassiFs,
  dir: string,
  sources: string[]
): Promise<void> {
  const target = await canonical(fs, dir);
  for (const source of sources) {
    const origin = await canonical(fs, source);
    if (contains(target, origin) || contains(origin, target)) {
      throw new LassiError('usage', `index directory ${dir} overlaps source directory ${source}`, {
        hint: 'choose storage.indexDir and an index name outside all export and source directories',
      });
    }
  }
  const manifest = pathApi(dir).join(dir, 'manifest.json');
  if (await fs.exists(manifest)) {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(manifest));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (isExportCandidate(value)) {
      throw new LassiError('usage', `index directory ${dir} contains an export manifest`, {
        hint: 'choose a different storage.indexDir or index name; the export was preserved',
      });
    }
  }
}
