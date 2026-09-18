import { describe, expect, it } from 'vitest';
import { memFs } from './mem-fs.js';

describe('memFs', () => {
  it('supports the LassiFs surface', async () => {
    const fs = memFs({ '/a/b.txt': 'hello' });
    expect(await fs.readFile('/a/b.txt')).toBe('hello');
    expect(await fs.exists('/a')).toBe(true);
    expect(await fs.exists('/a/b.txt')).toBe(true);
    expect(await fs.exists('/nope')).toBe(false);
    await fs.writeFile('/a/c/d.txt', 'x');
    expect(await fs.readdir('/a')).toEqual(['b.txt', 'c']);
    expect((await fs.stat('/a/b.txt')).size).toBe(5);
    expect((await fs.stat('/a')).isDirectory).toBe(true);
    expect(new TextDecoder().decode(await fs.readBytes('/a/b.txt'))).toBe('hello');
    await fs.rename('/a/b.txt', '/a/e.txt');
    expect(await fs.exists('/a/b.txt')).toBe(false);
    await fs.copyFile('/a/e.txt', '/z.txt');
    expect(await fs.readFile('/z.txt')).toBe('hello');
    await fs.unlink('/z.txt');
    await expect(fs.readFile('/z.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    fs.modes.set('/a/e.txt', 0o100644);
    expect((await fs.stat('/a/e.txt')).mode).toBe(0o100644);
  });
});
