export {
  chunkDocument,
  docMetaFromFrontmatter,
  type Chunk,
  type ChunkOptions,
  type ChunkedDocument,
  type DocMeta,
  type DocProduct,
} from './chunk/chunk.js';
export {
  createEmbeddingsClient,
  type EmbeddingsClient,
  type EmbeddingsClientOptions,
} from './embeddings/client.js';
export {
  indexMismatch,
  indexMismatchError,
  indexMismatchOf,
  type IndexMismatch,
} from './index/compat.js';
export { sha256 } from './index/hash.js';
export {
  buildIndex,
  planIndex,
  type BuildIndexInput,
  type BuildStats,
  type DocInput,
  type IndexPlan,
} from './index/build.js';
export {
  CHUNKS_FILE,
  MANIFEST_FILE,
  VECTORS_FILE,
  IndexDamagedError,
  decodeVectors,
  encodeVectors,
  isIndexDamaged,
  parseIndex,
  readIndex,
  readIndexManifest,
  parseIndexManifest,
  writeIndex,
  type ChunkRecord,
  type IndexManifest,
  type IndexedDoc,
  type LoadedIndex,
} from './index/store.js';
export { DEFAULT_MIN_SCORE, queryIndex, type QueryHit, type QueryOptions } from './query/query.js';
export { normalize, scores, topK } from './query/similarity.js';

export type { CorpusProvenance, DocumentOrigin, ExportProvenance } from './index/provenance.js';
