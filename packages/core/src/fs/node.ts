import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { LassiFs, FileStat } from './types.js';

/** The real filesystem behind `LassiFs`. Only the CLI (and scripts) should construct this. */
export function nodeFs(): LassiFs {
  return {
    readFile: (path) => fsp.readFile(path, 'utf8'),
    readBytes: (path) => fsp.readFile(path),
    async writeFile(path, data) {
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.writeFile(path, data, 'utf8');
    },
    async writeFileExclusive(path, data) {
      await fsp.mkdir(dirname(path), { recursive: true });
      const handle = await fsp.open(path, 'wx');
      try {
        await handle.writeFile(data, 'utf8');
        await handle.close();
      } catch (err) {
        await handle.close().catch(() => undefined);
        await fsp.unlink(path).catch(() => undefined);
        throw err;
      }
    },
    async writeBytes(path, data) {
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.writeFile(path, data);
    },
    async exists(path) {
      try {
        await fsp.access(path);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path): Promise<FileStat> {
      const s = await fsp.stat(path);
      return { mode: s.mode, mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
    },
    async mkdir(path) {
      await fsp.mkdir(path, { recursive: true });
    },
    readdir: (path) => fsp.readdir(path),
    async copyFile(from, to) {
      await fsp.mkdir(dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
    },
    unlink: (path) => fsp.unlink(path),
    rename: (from, to) => fsp.rename(from, to),
    realpath: (path) => fsp.realpath(path),
  };
}
