import type { DocProduct } from '../chunk/chunk.js';
import { indexMismatch, indexMismatchError } from '../index/compat.js';
import type { ChunkRecord, LoadedIndex } from '../index/store.js';
import { normalize, scores, topK } from './similarity.js';

export interface QueryHit extends ChunkRecord {
  score: number;
}

export interface QueryOptions {
  limit: number;
  /** Cosine similarity below this is noise, not a result. */
  minScore: number;
  product?: DocProduct;
}

/**
 * Cosine similarity below which a chunk is noise rather than a result. An embedding model puts
 * every pair of texts some distance apart, so this floor is what makes "no matches" mean anything,
 * the appropriate floor depends on the embedding model and
 * `embeddings.minScore` moves it. Kept in step with that config default by a test.
 */
export const DEFAULT_MIN_SCORE = 0.33;

/** Brute-force cosine over the whole index; one hit per document (its best chunk), best first. */
export function queryIndex(
  index: LoadedIndex,
  queryVector: Float32Array,
  opts: QueryOptions
): QueryHit[] {
  const dims = index.manifest.dimensions;
  const mismatch = indexMismatch(index.manifest, { dimensions: queryVector.length });
  if (mismatch) {
    throw indexMismatchError(
      `the embeddings endpoint returned ${mismatch.now}-dimensional vectors but index "${index.manifest.name}" holds ${mismatch.was}`,
      mismatch,
      'the model or the requested dimensions changed since the index was built; rebuild it from scratch, or restore the previous setting'
    );
  }
  if (opts.limit <= 0) return [];
  const all = scores(index.vectors, dims, normalize(queryVector));
  const best = new Map<string, QueryHit>();
  for (const row of topK(all, all.length)) {
    const score = all[row] as number;
    // Orthogonal is not a weak match, it is no match, so a floor of zero still means "no floor
    // beyond the meaningless": without this, `minScore: 0` would answer every query with the whole
    // index, and a query the endpoint could not embed at all would look like a hit on everything.
    // Written as `!(score > 0)` so a NaN score fails it; `score <= 0` is false for NaN.
    if (!(score > 0) || score < opts.minScore) break;
    const chunk = index.chunks[row] as ChunkRecord;
    if (opts.product && chunk.product !== opts.product) continue;
    if (!best.has(chunk.doc)) best.set(chunk.doc, { ...chunk, score });
    if (best.size >= opts.limit) break;
  }
  return [...best.values()];
}
