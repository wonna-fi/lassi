import { describe, expect, it } from 'vitest';
import { memFs } from './mem-fs.js';

describe('memFs binary surface', () => {
  it('stores bytes separately from text and serves both through the other reader', async () => {
    const fs = memFs({ '/idx/manifest.json': '{}' });
    const raw = new Uint8Array([0, 1, 2, 255]);
    await fs.writeBytes('/idx/vectors.f32', raw);
    expect(await fs.readBytes('/idx/vectors.f32')).toBe(raw);
    expect(await fs.exists('/idx/vectors.f32')).toBe(true);
    expect((await fs.stat('/idx/vectors.f32')).size).toBe(4);
    expect(await fs.readdir('/idx')).toEqual(['manifest.json', 'vectors.f32']);
    expect(new TextDecoder().decode(await fs.readBytes('/idx/manifest.json'))).toBe('{}');
    await fs.writeBytes('/idx/text.txt', new TextEncoder().encode('hi'));
    expect(await fs.readFile('/idx/text.txt')).toBe('hi');
  });

  it('renames, copies and unlinks binary files and lets text overwrite bytes', async () => {
    const fs = memFs();
    await fs.writeBytes('/a.bin', new Uint8Array([7]));
    await fs.rename('/a.bin', '/b.bin');
    expect(await fs.exists('/a.bin')).toBe(false);
    expect(await fs.readBytes('/b.bin')).toEqual(new Uint8Array([7]));
    await fs.copyFile('/b.bin', '/c.bin');
    expect(await fs.readBytes('/c.bin')).toEqual(new Uint8Array([7]));
    await fs.writeFile('/c.bin', 'now text');
    expect(fs.bytes.has('/c.bin')).toBe(false);
    expect(await fs.readFile('/c.bin')).toBe('now text');
    await fs.unlink('/b.bin');
    expect(await fs.exists('/b.bin')).toBe(false);
    await expect(fs.unlink('/b.bin')).rejects.toThrow(/ENOENT/);
  });

  it('copyFile replaces the destination in both content maps', async () => {
    // Only one map was written, so readFile and readBytes could disagree about the same path and
    // the in-memory filesystem stopped standing in for the real one.
    const fs = memFs({ '/a.txt': 'text' });
    await fs.writeBytes('/b.bin', Uint8Array.from([1, 2, 3]));
    await fs.copyFile('/a.txt', '/b.bin');
    expect(await fs.readFile('/b.bin')).toBe('text');
    expect(Array.from(await fs.readBytes('/b.bin'))).toEqual([...Buffer.from('text')]);
  });
});
