import { LassiConfigSchema } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import type { LoadedIndex } from '../index/store.js';
import { DEFAULT_MIN_SCORE, queryIndex } from './query.js';

const index: LoadedIndex = {
  manifest: {
    schema: 1,
    name: 'default',
    model: 'm',
    dimensions: 8,
    vectorEncoding: 'f32le',
    createdAt: '',
    updatedAt: '',
    chunkCount: 1,
    docs: {},
  },
  chunks: [
    { doc: 'a.md', ordinal: 0, product: 'jira', ref: 'A', title: 'A', heading: '', text: 'a' },
  ],
  vectors: new Float32Array(8),
};

describe('queryIndex', () => {
  it('reports a width mismatch as a validation error naming the way out', () => {
    expect(() => queryIndex(index, new Float32Array(4), { limit: 5, minScore: 0.2 })).toThrow(
      expect.objectContaining({
        code: 'validation',
        message: expect.stringContaining('index "default" holds 8'),
        hint: expect.stringContaining('rebuild it from scratch'),
      }) as unknown as Error
    );
  });
});

describe('DEFAULT_MIN_SCORE', () => {
  it('is the config default, so a library consumer and the CLI share one floor', () => {
    expect(DEFAULT_MIN_SCORE).toBe(LassiConfigSchema.parse({}).embeddings.minScore);
  });
});
