import { posix, win32 } from 'node:path';

/**
 * Picks the path flavour from the shape of the input rather than the host platform: `/home/u/x`
 * stays POSIX on a Windows runner and `C:\Users\x` stays win32 under WSL. Keeps reported paths
 * exactly in the style the user wrote them and makes tests platform-independent. User input passes
 * its base's flavour for ambiguous // paths; already-normalized stored paths retain UNC identity.
 */
export function pathApi(
  sample: string,
  slashContext?: typeof posix | typeof win32
): typeof posix | typeof win32 {
  // Persisted Windows paths use forward slashes, including the two leading UNC separators.
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(sample)) return win32;
  if (/^\/\/[^/]+\/[^/]+/.test(sample)) return slashContext ?? win32;
  if (sample.startsWith('/')) return posix;
  return sample.includes('\\') ? win32 : posix;
}

/** Stable stored paths: Windows separators become slashes; POSIX filename bytes stay intact. */
export function portablePath(path: string, api = pathApi(path)): string {
  const normalized = api.normalize(path);
  return api === win32 ? toPosix(normalized) : normalized;
}

/** Forward slashes only; for comparisons and display, never for filesystem calls. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Resolves a user-supplied path against `cwd`. An absolute argument keeps its own flavour (a Windows
 * `--out C:\tmp\x` is honoured even when the cwd looks POSIX, as under WSL or in tests); a relative one
 * follows the cwd. Ambiguous forward-slash UNC/POSIX paths follow the cwd's flavour too.
 */
export function resolvePath(cwd: string, path: string): string {
  const api = pathApi(cwd);
  // User input can be POSIX //tmp/archive or a forward-slash UNC path. The base disambiguates it.
  const own = pathApi(path, api);
  if (own.isAbsolute(path)) return own.normalize(path);
  return api.resolve(cwd, path);
}

/** Relative to `cwd` when both share a flavour, otherwise the path itself (display only). */
export function displayPath(cwd: string, path: string): string {
  if (pathApi(cwd) !== pathApi(path)) return path;
  const rel = pathApi(cwd).relative(cwd, path);
  return rel.length > 0 ? rel : path;
}
