import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateRetrieval, fixtureEmbedding, type RetrievalCorpus } from './retrieval.js';
import { retrievalMetrics, type RetrievalResult } from './metrics.js';

describe('retrieval evaluation', () => {
  it('measures recall, exact ordering and false positives independently', () => {
    const base = { query: 'fixture', language: 'en' as const };
    const results: RetrievalResult[] = [
      {
        ...base,
        id: 'two-relevant',
        kind: 'semantic',
        relevant: ['PROJ-1', 'PROJ-2'],
        hits: [
          { ref: 'PROJ-1', score: 1 },
          { ref: 'PROJ-1', score: 0.9 },
        ],
      },
      {
        ...base,
        id: 'exact',
        kind: 'exact',
        relevant: ['PROJ-3'],
        hits: [
          { ref: 'PROJ-4', score: 1 },
          { ref: 'PROJ-3', score: 0.8 },
        ],
      },
      { ...base, id: 'absent', kind: 'no-answer', relevant: [], hits: [] },
      {
        ...base,
        id: 'false-positive',
        kind: 'no-answer',
        relevant: [],
        hits: [{ ref: 'PROJ-5', score: 0.5 }],
      },
      { ...base, id: 'attachment', kind: 'attachment-only', relevant: [], hits: [] },
    ];
    expect(retrievalMetrics(results)).toMatchObject({
      recallAt5: 0.75,
      recallAt10: 0.75,
      exactTop1: 0,
      falsePositiveRate: 0.5,
      attachmentOnlyFalsePositiveRate: 0,
      irrelevantHitsAt10: 2,
      byLanguage: { fi: { recallAt5: null, recallAt10: null } },
    });
    expect(retrievalMetrics([])).toMatchObject({ recallAt5: null, falsePositiveRate: null });
  });

  it('does not retry a failed injected embeddings client through the fabricated transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-eval-failure-'));
    let calls = 0;
    try {
      const corpus = JSON.parse(
        await readFile(
          new URL('../../../../fixtures/search/retrieval-v1.json', import.meta.url),
          'utf8'
        )
      ) as RetrievalCorpus;
      await expect(
        evaluateRetrieval(corpus, {
          attachmentDir: dir,
          model: 'fixture',
          embed: async () => {
            calls++;
            throw new Error('endpoint refused');
          },
        })
      ).rejects.toThrow('endpoint refused');
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs issue reading, paginated discussion, attachment reading, export, index and query without network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-eval-test-'));
    try {
      const corpus = JSON.parse(
        await readFile(
          new URL('../../../../fixtures/search/retrieval-v1.json', import.meta.url),
          'utf8'
        )
      ) as RetrievalCorpus;
      const keys = new Set(corpus.issues.map((i) => i.key));
      expect(new Set(corpus.queries.map((q) => q.id)).size).toBe(corpus.queries.length);
      for (const q of corpus.queries)
        for (const ref of q.relevant) expect(keys.has(ref)).toBe(true);
      const result = await evaluateRetrieval(corpus, {
        attachmentDir: dir,
        model: 'fixture',
        embed: async (texts) => texts.map(fixtureEmbedding),
      });
      expect(result.pipeline).toMatchObject({
        discussion: { total: 7, shown: 7, complete: true, incomplete: false },
        lateCommentExported: true,
        attachments: { saved: 1, complete: true },
        attachmentOnlyTextIndexed: false,
        documents: 16,
        dimensions: 256,
      });
      expect(result.pipeline.attachments.readBytes).toBe(
        Buffer.byteLength(corpus.attachments['9001'] as string)
      );
      expect(result.cost.queryRequests).toBe(corpus.queries.length);
      expect(result.cost.stdoutBytes).toBeGreaterThan(0);
      expect(result.results).toHaveLength(23);
      expect(result.metrics.recallAt10).toBeGreaterThanOrEqual(0);
      expect(result.metrics.recallAt10).toBeLessThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
