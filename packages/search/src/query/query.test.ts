import { describe, expect, it } from 'vitest';
import type { LoadedIndex } from '../index/store.js';
import { queryIndex } from './query.js';
import { normalize, scores, topK } from './similarity.js';

function index(
  rows: Array<{ doc: string; product: 'jira' | 'confluence'; v: number[] }>
): LoadedIndex {
  const dims = rows[0]?.v.length ?? 0;
  const vectors = new Float32Array(rows.length * dims);
  rows.forEach((r, i) => vectors.set(normalize(Float32Array.from(r.v)), i * dims));
  return {
    manifest: {
      schema: 1,
      name: 'default',
      model: 'm',
      dimensions: dims,
      vectorEncoding: 'f32le',
      createdAt: '',
      updatedAt: '',
      chunkCount: rows.length,
      docs: {},
    },
    chunks: rows.map((r, i) => ({
      doc: r.doc,
      ordinal: i,
      product: r.product,
      ref: r.doc,
      title: r.doc,
      heading: `h${i}`,
      text: `t${i}`,
    })),
    vectors,
  };
}

describe('a vector that is not a vector', () => {
  const rows = [
    { doc: 'a.md', product: 'jira' as const, v: [1, 0] },
    { doc: 'b.md', product: 'jira' as const, v: [0, 1] },
  ];

  it('normalises a non-finite vector to zero, which the floor already rejects', () => {
    expect(Array.from(normalize(Float32Array.from([Number.NaN, 1])))).toEqual([0, 0]);
    // `sum === 0` was false for NaN, so the NaN used to divide through into every component.
    expect(
      queryIndex(index(rows), Float32Array.from([Number.NaN, 1]), {
        limit: 10,
        minScore: 0.33,
      })
    ).toEqual([]);
  });

  it('returns nothing for a limit of zero instead of one hit', () => {
    expect(queryIndex(index(rows), Float32Array.from([1, 0]), { limit: 0, minScore: 0 })).toEqual(
      []
    );
  });
});

describe('similarity', () => {
  it('normalises, scores by dot product and ranks with stable ties', () => {
    expect(Array.from(normalize(Float32Array.from([3, 4])))).toEqual([
      0.6000000238418579, 0.800000011920929,
    ]);
    expect(Array.from(normalize(Float32Array.from([0, 0])))).toEqual([0, 0]);
    const m = Float32Array.from([1, 0, 0, 1, 1, 0]);
    expect(Array.from(scores(m, 2, Float32Array.from([1, 0])))).toEqual([1, 0, 1]);
    expect(topK(Float32Array.from([0.1, 0.9, 0.9, 0.5]), 3)).toEqual([1, 2, 3]);
    expect(topK(Float32Array.from([0.1]), 0)).toEqual([]);
  });
});

describe('queryIndex', () => {
  const idx = index([
    { doc: 'a.md', product: 'jira', v: [1, 0, 0] },
    { doc: 'a.md', product: 'jira', v: [0.9, 0.1, 0] },
    { doc: 'b.md', product: 'confluence', v: [0.7, 0.7, 0] },
    { doc: 'c.md', product: 'jira', v: [0, 0, 1] },
  ]);

  it('returns one hit per document, best chunk first, above the threshold', () => {
    const hits = queryIndex(idx, Float32Array.from([1, 0, 0]), { limit: 10, minScore: 0.2 });
    expect(hits.map((h) => [h.doc, h.ordinal, Number(h.score.toFixed(3))])).toEqual([
      ['a.md', 0, 1],
      ['b.md', 2, 0.707],
    ]);
  });

  it('honours the limit and the product filter', () => {
    expect(
      queryIndex(idx, Float32Array.from([1, 0, 0]), { limit: 1, minScore: 0 }).map((h) => h.doc)
    ).toEqual(['a.md']);
    expect(
      queryIndex(idx, Float32Array.from([1, 1, 0]), {
        limit: 10,
        minScore: 0,
        product: 'confluence',
      }).map((h) => h.doc)
    ).toEqual(['b.md']);
    expect(() => queryIndex(idx, Float32Array.from([1, 0]), { limit: 1, minScore: 0 })).toThrow(
      /holds 3/
    );
  });
});
