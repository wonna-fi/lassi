import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../chunk/chunk.js';
import { buildIndex, planIndex, type DocInput } from './build.js';
import { sha256 } from './hash.js';
import type { LoadedIndex } from './store.js';

const chunk = (md: string, rel: string) =>
  chunkDocument(md, { maxChars: 1000, overlap: 100, fallbackRef: rel });
const now = () => new Date('2026-09-06T12:00:00.000Z');

/** Deterministic 3-dim vectors: length, vowel count and word count of each text. */
function fakeEmbed(calls: string[][]) {
  return async (texts: string[]): Promise<Float32Array[]> => {
    calls.push(texts);
    return texts.map((t) =>
      Float32Array.from([t.length, (t.match(/[aeiou]/gi) ?? []).length, t.split(/\s+/).length])
    );
  };
}

const DOCS: DocInput[] = [
  { rel: 'jira/PROJ-1.md', markdown: '---\nkey: PROJ-1\nsummary: One\n---\n\nBody one.\n' },
  { rel: 'jira/PROJ-2.md', markdown: '---\nkey: PROJ-2\nsummary: Two\n---\n\n## A\n\nBody two.\n' },
];

describe('buildIndex', () => {
  it('embeds every chunk of a fresh index with unit vectors and records the documents', async () => {
    const calls: string[][] = [];
    const { index, stats } = await buildIndex({
      name: 'default',
      model: 'm',
      previous: undefined,
      docs: DOCS,
      chunk,
      embed: fakeEmbed(calls),
      now,
    });
    expect(stats).toEqual({
      documents: 2,
      reused: 0,
      embedded: 2,
      dropped: 0,
      chunks: 4,
      embeddedChunks: 4,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    expect(index.manifest).toMatchObject({
      name: 'default',
      model: 'm',
      dimensions: 3,
      chunkCount: 4,
    });
    expect(Object.keys(index.manifest.docs)).toEqual(['jira/PROJ-1.md', 'jira/PROJ-2.md']);
    expect(index.manifest.docs['jira/PROJ-1.md']).toMatchObject({
      sha256: sha256(DOCS[0]?.markdown ?? ''),
      chunks: 2,
      product: 'jira',
      ref: 'PROJ-1',
      title: 'One',
      indexedAt: '2026-09-06T12:00:00.000Z',
    });
    for (let r = 0; r < 4; r++) {
      const row = index.vectors.subarray(r * 3, (r + 1) * 3);
      const len = Math.hypot(...row);
      expect(Math.abs(len - 1)).toBeLessThan(1e-5);
    }
  });

  it('reuses unchanged rows without embedding them, embeds changed ones and drops missing ones', async () => {
    const first = await buildIndex({
      name: 'd',
      model: 'm',
      previous: undefined,
      docs: DOCS,
      chunk,
      embed: fakeEmbed([]),
      now,
    });
    const changed: DocInput[] = [
      DOCS[0] as DocInput,
      { rel: 'jira/PROJ-3.md', markdown: '---\nkey: PROJ-3\nsummary: Three\n---\n\nNew.\n' },
    ];
    expect(planIndex(first.index, changed)).toEqual({
      reuse: ['jira/PROJ-1.md'],
      embed: ['jira/PROJ-3.md'],
      drop: ['jira/PROJ-2.md'],
    });
    const calls: string[][] = [];
    const second = await buildIndex({
      name: 'd',
      model: 'm',
      previous: first.index,
      docs: changed,
      chunk,
      embed: fakeEmbed(calls),
      now,
    });
    expect(second.stats).toEqual({
      documents: 2,
      reused: 1,
      embedded: 1,
      dropped: 1,
      chunks: 4,
      embeddedChunks: 2,
    });
    expect(calls[0]?.every((t) => t.includes('Three') || t.includes('New'))).toBe(true);
    expect(second.index.chunks.map((c) => c.doc)).toEqual([
      'jira/PROJ-1.md',
      'jira/PROJ-1.md',
      'jira/PROJ-3.md',
      'jira/PROJ-3.md',
    ]);
    expect(Array.from(second.index.vectors.subarray(0, 6))).toEqual(
      Array.from(first.index.vectors.subarray(0, 6))
    );
    expect(second.index.manifest.createdAt).toBe(first.index.manifest.createdAt);
    expect(second.index.manifest.docs['jira/PROJ-2.md']).toBeUndefined();
  });

  it('refuses a model change or a dimension drift with a hint', async () => {
    const first = await buildIndex({
      name: 'd',
      model: 'm',
      previous: undefined,
      docs: DOCS,
      chunk,
      embed: fakeEmbed([]),
      now,
    });
    await expect(
      buildIndex({
        name: 'd',
        model: 'other',
        previous: first.index,
        docs: DOCS,
        chunk,
        embed: fakeEmbed([]),
        now,
      })
    ).rejects.toMatchObject({
      code: 'validation',
      hint: expect.stringContaining('build under another name'),
    });
    const drift = async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]));
    const changed = [
      { rel: 'jira/PROJ-1.md', markdown: DOCS[0]?.markdown.replace('one', 'uno') ?? '' },
    ];
    await expect(
      buildIndex({
        name: 'd',
        model: 'm',
        previous: first.index,
        docs: changed,
        chunk,
        embed: drift,
        now,
      })
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('3-dimensional'),
    });
    const previous: LoadedIndex | undefined = undefined;
    const short = async (texts: string[]) => texts.slice(1).map(() => Float32Array.from([1]));
    await expect(
      buildIndex({ name: 'd', model: 'm', previous, docs: DOCS, chunk, embed: short, now })
    ).rejects.toThrow(/returned 3 vectors for 4 inputs/);
  });
});
