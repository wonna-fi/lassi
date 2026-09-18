import { pathApi } from '../fs/paths.js';

/** Expands a leading `~` or `~/` to the home directory; other paths are returned unchanged. */
export function expandHome(path: string, homedir: string): string {
  if (path === '~') return homedir;
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${homedir}${path.slice(1)}`;
  return path;
}

export const WORKSPACE_CONFIG_NAME = '.lassi.json';
/** Find the closest workspace configuration. */
export async function findWorkspaceConfig(
  startDir: string,
  exists: (path: string) => Promise<boolean>
): Promise<string | undefined> {
  const api = pathApi(startDir);
  let dir = startDir;
  for (;;) {
    const candidate = api.join(dir, WORKSPACE_CONFIG_NAME);
    if (await exists(candidate)) return candidate;
    const parent = api.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
