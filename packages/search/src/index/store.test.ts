import { memFs } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import {
  decodeVectors,
  encodeVectors,
  isIndexDamaged,
  readIndex,
  writeIndex,
  type LoadedIndex,
} from './store.js';

describe('vector encoding', () => {
  it('is explicit little-endian float32 and round-trips', () => {
    const bytes = encodeVectors([Float32Array.from([1, -2]), Float32Array.from([0.5, 0])], 2);
    expect(Array.from(bytes)).toEqual([0, 0, 128, 63, 0, 0, 0, 192, 0, 0, 0, 63, 0, 0, 0, 0]);
    expect(Array.from(decodeVectors(bytes, 2))).toEqual([1, -2, 0.5, 0]);
    expect(() => decodeVectors(bytes, 3)).toThrow(/multiple/);
    expect(() => encodeVectors([Float32Array.from([1])], 2)).toThrow(/dimensions/);
  });
});

async function writeManifest(
  fs: ReturnType<typeof memFs>,
  manifest: LoadedIndex['manifest']
): Promise<void> {
  await fs.writeFile('/i/manifest.json', JSON.stringify(manifest));
}

describe('readIndex / writeIndex', () => {
  const index: LoadedIndex = {
    manifest: {
      schema: 1,
      name: 'default',
      model: 'text-embedding-3-small',
      dimensions: 2,
      vectorEncoding: 'f32le',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
      chunkCount: 2,
      docs: {
        'jira/PROJ-1.md': {
          sha256: 'abc',
          chunks: 2,
          product: 'jira',
          ref: 'PROJ-1',
          title: 'T',
          indexedAt: 'x',
        },
      },
    },
    chunks: [
      {
        doc: 'jira/PROJ-1.md',
        ordinal: 0,
        product: 'jira',
        ref: 'PROJ-1',
        title: 'T',
        heading: '',
        text: 'meta',
      },
      {
        doc: 'jira/PROJ-1.md',
        ordinal: 1,
        product: 'jira',
        ref: 'PROJ-1',
        title: 'T',
        heading: 'H',
        text: 'body, with "quotes"',
      },
    ],
    vectors: Float32Array.from([1, 0, 0, 1]),
  };

  it('writes three files atomically and reads them back identical', async () => {
    const fs = memFs();
    await writeIndex(fs, '/w/.lassi/index/default', index);
    expect(await fs.readdir('/w/.lassi/index/default')).toEqual([
      'chunks.jsonl',
      'manifest.json',
      'vectors.f32',
    ]);
    expect((await fs.readFile('/w/.lassi/index/default/chunks.jsonl')).split('\n')).toHaveLength(3);
    const back = await readIndex(fs, '/w/.lassi/index/default');
    expect(back?.manifest).toEqual({
      ...index.manifest,
      chunksSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      vectorsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(back?.chunks).toEqual(index.chunks);
    expect(Array.from(back?.vectors ?? [])).toEqual([1, 0, 0, 1]);
  });

  it('returns undefined for a missing index and calls a changed file damage', async () => {
    expect(await readIndex(memFs(), '/nope')).toBeUndefined();
    const fs = memFs();
    await writeIndex(fs, '/i', index);
    await fs.writeFile('/i/chunks.jsonl', `${JSON.stringify(index.chunks[0])}\n`);
    await expect(readIndex(fs, '/i')).rejects.toThrow(
      /chunks\.jsonl is not the file the manifest was written with/
    );
    await expect(readIndex(fs, '/i')).rejects.toSatisfy(isIndexDamaged);
  });

  // Only the manifest names both other files, so it is the one thing that can prove they belong
  // together: without this, a write interrupted between two renames pairs new vectors with old text.
  it('catches either data file arriving without the manifest that describes it', async () => {
    const fs = memFs();
    await writeIndex(fs, '/i', index);
    const other: LoadedIndex = { ...index, vectors: Float32Array.from([0, 1, 1, 0]) };
    const staging = memFs();
    await writeIndex(staging, '/i', other);
    await fs.writeBytes('/i/vectors.f32', await staging.readBytes('/i/vectors.f32'));
    await expect(readIndex(fs, '/i')).rejects.toThrow(
      /vectors\.f32 is not the file the manifest was written with/
    );
  });

  it('reports a missing data file as damage rather than as no index at all', async () => {
    for (const file of ['chunks.jsonl', 'vectors.f32']) {
      const fs = memFs();
      await writeIndex(fs, '/i', index);
      await fs.unlink(`/i/${file}`);
      await expect(readIndex(fs, '/i')).rejects.toThrow(`missing ${file}`);
      await expect(readIndex(fs, '/i')).rejects.toSatisfy(isIndexDamaged);
    }
  });

  // The manifest is written last, so it can survive a write the other two files did not finish.
  it('refuses a manifest that describes rows the other files do not hold', async () => {
    // An index written before the manifest carried hashes: the counts are all such a reader has.
    const truncate = async (
      manifest: LoadedIndex['manifest'] = index.manifest
    ): Promise<ReturnType<typeof memFs>> => {
      const fs = memFs();
      await writeIndex(fs, '/i', index);
      await writeManifest(fs, manifest);
      await fs.writeFile('/i/chunks.jsonl', `${JSON.stringify(index.chunks[0])}\n`);
      await fs.writeBytes('/i/vectors.f32', encodeVectors([Float32Array.from([1, 0])], 2));
      return fs;
    };
    await expect(readIndex(await truncate(), '/i')).rejects.toThrow(
      /manifest counts 2 chunks, 1 are stored/
    );

    await expect(
      readIndex(await truncate({ ...index.manifest, chunkCount: 1 }), '/i')
    ).rejects.toThrow(/jira\/PROJ-1\.md is recorded with 2 chunks, 1 are stored/);

    await expect(
      readIndex(await truncate({ ...index.manifest, chunkCount: 1, docs: {} }), '/i')
    ).rejects.toThrow(/jira\/PROJ-1\.md has rows but no record/);
  });
});
