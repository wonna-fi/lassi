import { memFs } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../chunk/chunk.js';
import { buildIndex, planIndex, type DocInput } from './build.js';
import { isIndexDamaged, readIndex, writeIndex, type LoadedIndex } from './store.js';

const index: LoadedIndex = {
  manifest: {
    schema: 1,
    name: 'default',
    model: 'm',
    dimensions: 2,
    vectorEncoding: 'f32le',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    chunkCount: 1,
    docs: {
      'a.md': { sha256: 'x', chunks: 1, product: 'jira', ref: 'A', title: 'A', indexedAt: '' },
    },
  },
  chunks: [
    { doc: 'a.md', ordinal: 0, product: 'jira', ref: 'A', title: 'A', heading: '', text: 'a' },
  ],
  vectors: Float32Array.from([1, 0]),
};

describe('writeIndex durability', () => {
  it('publishes the manifest last, so a failed vector write leaves no half-written index', async () => {
    const fs = memFs();
    const failing = {
      ...fs,
      writeBytes: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    };
    await expect(writeIndex(failing, '/i', index)).rejects.toThrow(/ENOSPC/);
    // Nothing a reader would trust: the manifest names the model and the counts.
    expect(await fs.exists('/i/manifest.json')).toBe(false);
    expect(await readIndex(fs, '/i')).toBeUndefined();
  });

  it('leaves the previous index readable when a later write fails', async () => {
    const fs = memFs();
    await writeIndex(fs, '/i', index);
    const second: LoadedIndex = {
      manifest: { ...index.manifest, chunkCount: 1, updatedAt: '2026-09-07T00:00:00.000Z' },
      chunks: [{ ...(index.chunks[0] as (typeof index.chunks)[number]), text: 'b' }],
      vectors: Float32Array.from([0, 1]),
    };
    const failing = {
      ...fs,
      writeFile: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    };
    await expect(writeIndex(failing, '/i', second)).rejects.toThrow(/ENOSPC/);
    // The vectors used to be renamed into place first, so the old manifest ended up describing new
    // vectors and the next read demanded a full re-embed.
    const still = await readIndex(fs, '/i');
    expect(still?.chunks[0]?.text).toBe('a');
    expect([...(still?.vectors ?? [])]).toEqual([1, 0]);
  });

  it('reclaims its temporary files when a write fails', async () => {
    const fs = memFs();
    const failing = {
      ...fs,
      writeFile: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    };
    await expect(writeIndex(failing, '/i', index)).rejects.toThrow(/ENOSPC/);
    const left = [...fs.files.keys(), ...fs.bytes.keys()].filter((p) => p.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('refuses to write an index of zero-width vectors, which could never be read back', async () => {
    const fs = memFs();
    const empty: LoadedIndex = {
      manifest: { ...index.manifest, dimensions: 0, chunkCount: 0, docs: {} },
      chunks: [],
      vectors: new Float32Array(0),
    };
    await expect(writeIndex(fs, '/i', empty)).rejects.toThrow(/0 dimensions/);
    expect(await fs.exists('/i/manifest.json')).toBe(false);
  });
});

describe('buildIndex with nothing to embed', () => {
  it('refuses to build an index that could never be read back', async () => {
    // The CLI stops an empty corpus earlier, but the library export is the cron and Functions entry
    // point  and had no guard: it wrote a manifest of width zero that readIndex rejects.
    await expect(
      buildIndex({
        name: 'd',
        model: 'm',
        previous: undefined,
        docs: [],
        chunk: (md, rel) => chunkDocument(md, { maxChars: 900, overlap: 100, fallbackRef: rel }),
        embed: async () => [],
        now: () => new Date('2026-09-06T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('nothing to index'),
    });
  });
});

describe('a manifest that is not one', () => {
  const write = async (manifest: unknown): Promise<ReturnType<typeof memFs>> => {
    const fs = memFs();
    await writeIndex(fs, '/i', index);
    await fs.writeFile('/i/manifest.json', JSON.stringify(manifest));
    return fs;
  };

  it('reads as damage rather than a raw TypeError when docs is missing', async () => {
    const { docs: _docs, ...withoutDocs } = index.manifest;
    const fs = await write({ ...withoutDocs, chunksSha256: undefined, vectorsSha256: undefined });
    await expect(readIndex(fs, '/i')).rejects.toSatisfy(
      (e: unknown) => isIndexDamaged(e) && e.message.includes('docs is')
    );
  });

  it('refuses a schema it does not know', async () => {
    const fs = await write({ ...index.manifest, schema: 2 });
    await expect(readIndex(fs, '/i')).rejects.toSatisfy(
      (e: unknown) => isIndexDamaged(e) && e.message.includes('unsupported schema 2')
    );
  });

  it('refuses a dimensions field that is not a positive integer', async () => {
    const fs = await write({ ...index.manifest, dimensions: 'two' });
    await expect(readIndex(fs, '/i')).rejects.toSatisfy(
      (e: unknown) => isIndexDamaged(e) && e.message.includes('dimensions is')
    );
  });
});

describe('chunkDocument with a pathological overlap', () => {
  it('terminates instead of spinning when the overlap reaches the cut point', () => {
    const md = `# T\n\n${'x'.repeat(800)}\n\n${'y'.repeat(2000)}\n`;
    const doc = chunkDocument(md, { maxChars: 1500, overlap: 900, fallbackRef: 'n.md' });
    expect(doc.chunks.length).toBeGreaterThan(1);
    expect(doc.chunks.length).toBeLessThan(50);
    for (const c of doc.chunks) expect(c.text.length).toBeLessThanOrEqual(1500);
    // Every piece of the source survives somewhere in the chunks.
    const joined = doc.chunks.map((c) => c.text).join('');
    expect(joined).toContain('y'.repeat(200));
  });
});

describe('planIndex', () => {
  it('indexes a document once even when overlapping directories offer it twice', async () => {
    const doc: DocInput = {
      rel: 'exp/PROJ-1.md',
      markdown: '---\nkey: PROJ-1\nsummary: One\n---\n\nBody.\n',
    };
    expect(planIndex(undefined, [doc, { ...doc }])).toEqual({
      reuse: [],
      embed: ['exp/PROJ-1.md'],
      drop: [],
    });
    const built = await buildIndex({
      name: 'd',
      model: 'm',
      previous: undefined,
      docs: [doc, { ...doc }],
      chunk: (md, rel) => chunkDocument(md, { maxChars: 900, overlap: 100, fallbackRef: rel }),
      embed: async (texts) => texts.map(() => Float32Array.from([1, 0])),
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    expect(Object.keys(built.index.manifest.docs)).toEqual(['exp/PROJ-1.md']);
    // The count the CLI prints is what was indexed, not what the walk offered: two overlapping
    // source directories used to report "indexed 2 documents (1 embedded, 0 reused)".
    expect(built.stats.documents).toBe(1);
    expect(built.stats.chunks).toBe(built.index.chunks.length);
    expect(new Set(built.index.chunks.map((c) => `${c.doc}#${c.ordinal}`)).size).toBe(
      built.index.chunks.length
    );
  });

  it('refuses a configured dimension change even when every document is unchanged', async () => {
    const docs: DocInput[] = [{ rel: 'a.md', markdown: '---\nkey: A\nsummary: A\n---\n\nBody.\n' }];
    const chunk = (md: string, rel: string) =>
      chunkDocument(md, { maxChars: 900, overlap: 100, fallbackRef: rel });
    const first = await buildIndex({
      name: 'd',
      model: 'm',
      previous: undefined,
      docs,
      chunk,
      embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])),
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    await expect(
      buildIndex({
        name: 'd',
        model: 'm',
        dimensions: 2,
        previous: first.index,
        docs,
        chunk,
        embed: async () => [],
        now: () => new Date('2026-09-06T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('4-dimensional'),
      hint: expect.stringContaining('build under another name'),
    });
  });
});

describe('a plan handed to buildIndex', () => {
  it('is used as given, so the corpus is hashed once instead of twice', async () => {
    const docs: DocInput[] = [
      { rel: 'a.md', markdown: '---\nkey: A\nsummary: A\n---\n\nBody.\n' },
      { rel: 'b.md', markdown: '---\nkey: B\nsummary: B\n---\n\nBody.\n' },
    ];
    const plan = planIndex(undefined, docs);
    const embedded: string[][] = [];
    const built = await buildIndex({
      name: 'd',
      model: 'm',
      previous: undefined,
      docs,
      plan,
      chunk: (md, rel) => chunkDocument(md, { maxChars: 900, overlap: 100, fallbackRef: rel }),
      embed: async (texts) => {
        embedded.push(texts);
        return texts.map(() => Float32Array.from([1, 0]));
      },
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    expect(Object.keys(built.index.manifest.docs).sort()).toEqual(['a.md', 'b.md']);
    expect(built.stats.embedded).toBe(2);
    expect(embedded).toHaveLength(1);
  });
});
