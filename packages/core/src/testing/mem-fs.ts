import { portablePath } from '../fs/paths.js';
import type { LassiFs, FileStat } from '../fs/types.js';

export interface MemFs extends LassiFs {
  files: Map<string, string>;
  /** Binary files written with `writeBytes`; `readBytes` prefers this map. */
  bytes: Map<string, Uint8Array>;
  /** Override the mode reported for a path (default 0o600). */
  modes: Map<string, number>;
  /** Override the mtime reported for a path (default 0). */
  mtimes: Map<string, number>;
}

function norm(path: string): string {
  return portablePath(path);
}

/** In-memory `LassiFs`. Directories exist implicitly whenever a file lives under them. */
export function memFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const modes = new Map<string, number>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>(['/']);
  for (const [p, content] of Object.entries(initial)) files.set(norm(p), content);

  const isDir = (p: string): boolean => {
    if (dirs.has(p)) return true;
    const prefix = p.endsWith('/') ? p : `${p}/`;
    for (const key of [...files.keys(), ...bytes.keys()]) if (key.startsWith(prefix)) return true;
    return false;
  };
  const has = (p: string): boolean => files.has(p) || bytes.has(p);

  const notFound = (p: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

  return {
    files,
    bytes,
    modes,
    mtimes,
    async readFile(path) {
      const p = norm(path);
      const content = files.get(p);
      if (content !== undefined) return content;
      const raw = bytes.get(p);
      if (raw !== undefined) return new TextDecoder().decode(raw);
      throw notFound(p);
    },
    async readBytes(path) {
      const p = norm(path);
      const raw = bytes.get(p);
      if (raw !== undefined) return raw;
      const content = files.get(p);
      if (content === undefined) throw notFound(p);
      return new TextEncoder().encode(content);
    },
    async writeFile(path, data) {
      const p = norm(path);
      bytes.delete(p);
      files.set(p, data);
    },
    async writeFileExclusive(path, data) {
      const p = norm(path);
      if (has(p) || isDir(p)) throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      files.set(p, data);
    },
    async writeBytes(path, data) {
      const p = norm(path);
      files.delete(p);
      bytes.set(p, data);
    },
    async exists(path) {
      const p = norm(path);
      return has(p) || isDir(p);
    },
    async stat(path): Promise<FileStat> {
      const p = norm(path);
      if (has(p)) {
        return {
          mode: modes.get(p) ?? 0o100600,
          mtimeMs: mtimes.get(p) ?? 0,
          size: files.has(p)
            ? Buffer.byteLength(files.get(p) as string)
            : (bytes.get(p)?.byteLength ?? 0),
          isDirectory: false,
        };
      }
      if (isDir(p)) return { mode: 0o040755, mtimeMs: 0, size: 0, isDirectory: true };
      throw notFound(p);
    },
    async mkdir(path) {
      dirs.add(norm(path));
    },
    async readdir(path) {
      const p = norm(path);
      if (!isDir(p)) throw notFound(p);
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...bytes.keys(), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0] as string);
      }
      names.delete('');
      return [...names].sort();
    },
    async copyFile(from, to) {
      const f = norm(from);
      const t = norm(to);
      // Clearing the other map, like `rename` and the writers: a real copyFile replaces the
      // destination wholesale, and without this `readFile` and `readBytes` disagreed about a path.
      if (files.has(f)) {
        files.set(t, files.get(f) as string);
        bytes.delete(t);
      } else if (bytes.has(f)) {
        bytes.set(t, bytes.get(f) as Uint8Array);
        files.delete(t);
      } else throw notFound(from);
    },
    // No symlinks in memory: the canonical path is the normalised one, when it exists.
    async realpath(path) {
      const p = norm(path);
      if (!has(p) && !isDir(p)) throw notFound(p);
      return p;
    },
    async unlink(path) {
      const p = norm(path);
      if (!files.delete(p) && !bytes.delete(p)) throw notFound(path);
    },
    async rename(from, to) {
      const f = norm(from);
      const t = norm(to);
      if (files.has(f)) {
        files.set(t, files.get(f) as string);
        files.delete(f);
        bytes.delete(t);
      } else if (bytes.has(f)) {
        bytes.set(t, bytes.get(f) as Uint8Array);
        bytes.delete(f);
        files.delete(t);
      } else throw notFound(from);
    },
  };
}
