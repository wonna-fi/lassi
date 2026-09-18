export interface RetrievalQuestion {
  id: string;
  query: string;
  relevant: string[];
  kind: 'exact' | 'semantic' | 'no-answer' | 'attachment-only';
  language: 'en' | 'fi';
}
export interface RetrievalResult extends RetrievalQuestion {
  hits: Array<{ ref: string; score: number }>;
}
const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const recall = (r: RetrievalResult, k: number): number => {
  const relevant = new Set(r.relevant);
  const retrieved = new Set(r.hits.slice(0, k).map((h) => h.ref));
  return [...relevant].filter((ref) => retrieved.has(ref)).length / relevant.size;
};

/** Missing answers do not enter recall's denominator; they measure false positives separately. */
export function retrievalMetrics(results: RetrievalResult[]) {
  const positives = results.filter((r) => r.relevant.length > 0);
  const negatives = results.filter((r) => r.kind === 'no-answer');
  const attachmentOnly = results.filter((r) => r.kind === 'attachment-only');
  return {
    recallAt5: mean(positives.map((r) => recall(r, 5))),
    recallAt10: mean(positives.map((r) => recall(r, 10))),
    exactTop1: mean(
      results
        .filter((r) => r.kind === 'exact')
        .map((r) => (r.hits[0] && r.relevant.includes(r.hits[0].ref) ? 1 : 0))
    ),
    falsePositiveRate: mean(negatives.map((r) => (r.hits.length ? 1 : 0))),
    attachmentOnlyFalsePositiveRate: mean(attachmentOnly.map((r) => (r.hits.length ? 1 : 0))),
    irrelevantHitsAt10: results.reduce(
      (sum, r) => sum + r.hits.slice(0, 10).filter((h) => !r.relevant.includes(h.ref)).length,
      0
    ),
    byLanguage: Object.fromEntries(
      ['en', 'fi'].map((lang) => [
        lang,
        {
          recallAt5: mean(positives.filter((r) => r.language === lang).map((r) => recall(r, 5))),
          recallAt10: mean(positives.filter((r) => r.language === lang).map((r) => recall(r, 10))),
        },
      ])
    ),
  };
}
