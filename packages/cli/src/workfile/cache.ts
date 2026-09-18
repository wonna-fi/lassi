import { pathApi, type LassiFs } from '@wonna/lassi-core';
import { serverContentId, serverIssueKey } from '../commands/shared/identifiers.js';
import type { LassiDirs } from './paths.js';

// Every cache path is named after an identifier the server chose, so each one is checked here
// rather than at the call sites: `join` would normalise a `..` in it straight out of `.lassi`.
export function jiraCachePath(dirs: LassiDirs, key: string): string {
  return pathApi(dirs.cache).join(dirs.cache, 'jira', `${serverIssueKey(key)}.json`);
}

export function confluenceCachePath(dirs: LassiDirs, id: string, version: number): string {
  const name = `${serverContentId(id)}.v${Math.trunc(version)}.xml`;
  return pathApi(dirs.cache).join(dirs.cache, 'confluence', name);
}

/** Sidecar for a page's generated sections and fetch metadata; the storage body is the `.xml`. */
export function confluencePageCachePath(dirs: LassiDirs, id: string): string {
  return pathApi(dirs.cache).join(dirs.cache, 'confluence', `${serverContentId(id)}.json`);
}

/**
 * A damaged cache is the same answer as no cache: the commands that read it already say what to run
 * to rebuild it. Reporting a JSON parser message as an internal failure told the user nothing.
 */
export async function readJsonCache<T>(
  path: string,
  fs: LassiFs,
  onDamaged?: (path: string) => void
): Promise<T | undefined> {
  if (!(await fs.exists(path))) return undefined;
  try {
    return JSON.parse(await fs.readFile(path)) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    onDamaged?.(path);
    return undefined;
  }
}

export async function writeJsonCache(path: string, value: unknown, fs: LassiFs): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
