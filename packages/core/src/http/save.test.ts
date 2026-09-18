import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { publishExclusive, saveStream } from './save.js';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('saveStream', () => {
  it('pipes into a Writable and counts bytes', async () => {
    const sink = new PassThrough();
    const collected: Buffer[] = [];
    sink.on('data', (c: Buffer) => collected.push(c));
    const { bytes } = await saveStream(stream(['hel', 'lo']), sink);
    expect(bytes).toBe(5);
    expect(Buffer.concat(collected).toString()).toBe('hello');
  });

  it('writes to a path atomically and creates parent directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
    dirs.push(dir);
    const dest = join(dir, 'nested', 'file.txt');
    expect(await saveStream(stream(['abc']), dest)).toEqual({ bytes: 3 });
    expect(await readFile(dest, 'utf8')).toBe('abc');
    expect(await readdir(join(dir, 'nested'))).toEqual(['file.txt']);
  });

  it('enforces the byte cap and leaves no partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
    dirs.push(dir);
    const dest = join(dir, 'big.bin');
    await expect(
      saveStream(stream(['0123456789', '0123456789']), dest, { maxBytes: 15 })
    ).rejects.toMatchObject({
      name: 'LassiError',
      code: 'validation',
      message: 'download exceeds the 15 byte limit',
    });
    expect(await readdir(dir)).toEqual([]);
  });
});

it('publishes concurrent identical downloads without replacing existing bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
  dirs.push(dir);
  const dest = join(dir, 'same.txt');
  const results = await Promise.all([
    saveStream(stream(['same']), dest, { preserveExisting: true }),
    saveStream(stream(['same']), dest, { preserveExisting: true }),
  ]);
  expect(results.filter((r) => r.unchanged)).toHaveLength(1);
  expect(await readFile(dest, 'utf8')).toBe('same');
  await expect(
    saveStream(stream(['edit']), dest, { preserveExisting: true })
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(await readFile(dest, 'utf8')).toBe('same');
  expect(await readdir(dir)).toEqual(['same.txt']);
});

it('cleans an interrupted download without changing the existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
  dirs.push(dir);
  const dest = join(dir, 'same.txt');
  await saveStream(stream(['original']), dest);
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('connection lost'));
    },
  });
  await expect(saveStream(broken, dest, { preserveExisting: true })).rejects.toThrow(
    'connection lost'
  );
  expect(await readFile(dest, 'utf8')).toBe('original');
  expect(await readdir(dir)).toEqual(['same.txt']);
});

it('supports valid long destination names and keeps normal file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
  dirs.push(dir);
  const dest = join(dir, `${'a'.repeat(220)}.txt`);
  await writeFile(join(dir, 'reference.txt'), 'reference');
  await saveStream(stream(['content']), dest, { preserveExisting: true });
  expect(await readFile(dest, 'utf8')).toBe('content');
  expect((await stat(dest)).mode & 0o777).toBe(
    (await stat(join(dir, 'reference.txt'))).mode & 0o777
  );
});

it('falls back to exclusive copying when hard links are unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lassi-save-'));
  dirs.push(dir);
  const source = join(dir, 'source');
  const dest = join(dir, 'dest');
  await writeFile(source, 'new');
  const io = {
    link: async () => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    },
    copyFile,
  };
  await publishExclusive(source, dest, io);
  expect(await readFile(dest, 'utf8')).toBe('new');
  await writeFile(source, 'other');
  await expect(publishExclusive(source, dest, io)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(dest, 'utf8')).toBe('new');
});
