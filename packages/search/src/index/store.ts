import { pathApi, type LassiFs } from '@wonna/lassi-core';
import type { DocProduct } from '../chunk/chunk.js';
import { sha256 } from './hash.js';
import {
  isCorpusProvenance,
  isDocumentOrigin,
  type CorpusProvenance,
  type DocumentOrigin,
} from './provenance.js';

export interface IndexedDoc {
  sha256: string;
  chunks: number;
  product: DocProduct;
  ref: string;
  title: string;
  indexedAt: string;
  origin?: DocumentOrigin;
}

export interface IndexManifest {
  schema: 1;
  name: string;
  model: string;
  dimensions: number;
  vectorEncoding: 'f32le';
  createdAt: string;
  updatedAt: string;
  chunkCount: number;
  /** Document path supplied by the caller → what was indexed. */
  docs: Record<string, IndexedDoc>;
  /** The two data files as they were written. Absent in indexes written before they were added. */
  chunksSha256?: string;
  vectorsSha256?: string;
  corpus?: CorpusProvenance;
  chunkFingerprint?: string;
}

/**
 * Damage in the index files themselves: the state `--rebuild` exists to replace. A filesystem that
 * will not answer is a different thing and is never reported as this, because re-embedding a corpus
 * costs real money and would fail again on the same unreadable file.
 */
export class IndexDamagedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IndexDamagedError';
  }
}

/** Structural, like `isLassiError`: an error thrown by another copy of the package still classifies. */
export function isIndexDamaged(value: unknown): value is IndexDamagedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'IndexDamagedError'
  );
}

/** One line of `chunks.jsonl`; row `i` of `vectors.f32` is its vector. */
export interface ChunkRecord {
  doc: string;
  ordinal: number;
  product: DocProduct;
  ref: string;
  title: string;
  heading: string;
  text: string;
  url?: string;
}

export interface LoadedIndex {
  manifest: IndexManifest;
  chunks: ChunkRecord[];
  /** Row-major, `chunks.length × manifest.dimensions`, unit-normalised. */
  vectors: Float32Array;
}

export const MANIFEST_FILE = 'manifest.json';
export const CHUNKS_FILE = 'chunks.jsonl';
export const VECTORS_FILE = 'vectors.f32';

/** Explicit little-endian float32 so an index written on one machine reads on any other. */
export function encodeVectors(vectors: Float32Array[], dims: number): Uint8Array {
  const out = new Uint8Array(vectors.length * dims * 4);
  const view = new DataView(out.buffer);
  vectors.forEach((vector, row) => {
    if (vector.length !== dims)
      throw new Error(`vector ${row} has ${vector.length} dimensions, expected ${dims}`);
    for (let d = 0; d < dims; d++) view.setFloat32((row * dims + d) * 4, vector[d] as number, true);
  });
  return out;
}

export function decodeVectors(bytes: Uint8Array, dims: number): Float32Array {
  if (dims <= 0 || bytes.byteLength % (dims * 4) !== 0) {
    throw new Error(`vector file has ${bytes.byteLength} bytes, not a multiple of ${dims} × 4`);
  }
  const count = bytes.byteLength / 4;
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new IndexDamagedError(`${what} is not valid JSON`, { cause: err });
  }
}

/**
 * The manifest is JSON from disk, so nothing about its shape is guaranteed by the type. Checking it
 * before use is what keeps a truncated or foreign file classified as damage the user can `--rebuild`
 * out of, rather than a raw `TypeError` the CLI has to report as an internal failure.
 */
function assertManifestShape(manifest: IndexManifest): void {
  const damaged = (what: string): never => {
    throw new IndexDamagedError(`${MANIFEST_FILE} is not an index manifest: ${what}`);
  };
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    damaged('not an object');
  }
  // Written since the first index and never read until now: a future schema 2 must not be parsed
  // by a binary that predates it.
  if (manifest.schema !== 1) damaged(`unsupported schema ${JSON.stringify(manifest.schema)}`);
  if (!Number.isInteger(manifest.dimensions) || manifest.dimensions <= 0) {
    damaged(`dimensions is ${JSON.stringify(manifest.dimensions)}`);
  }
  if (!Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 0) {
    damaged(`chunkCount is ${JSON.stringify(manifest.chunkCount)}`);
  }
  if (manifest.corpus !== undefined && !isCorpusProvenance(manifest.corpus))
    damaged('invalid corpus provenance');
  if (manifest.chunkFingerprint !== undefined && typeof manifest.chunkFingerprint !== 'string')
    damaged('invalid chunk fingerprint');
  const { docs } = manifest;
  if (typeof docs !== 'object' || docs === null || Array.isArray(docs)) {
    damaged(`docs is ${JSON.stringify(docs)}`);
  }
  for (const doc of Object.values(docs)) {
    if (
      typeof doc !== 'object' ||
      doc === null ||
      (doc.origin !== undefined && !isDocumentOrigin(doc.origin))
    )
      damaged('invalid document provenance');
  }
}

/** Read source identity even if chunks or vectors are damaged. */
export function parseIndexManifest(text: string): IndexManifest {
  const manifest = parseJson<IndexManifest>(text, MANIFEST_FILE);
  assertManifestShape(manifest);
  return manifest;
}

export async function readIndexManifest(
  fs: LassiFs,
  dir: string
): Promise<IndexManifest | undefined> {
  const path = pathApi(dir).join(dir, MANIFEST_FILE);
  if (!(await fs.exists(path))) return undefined;
  return parseIndexManifest(await fs.readFile(path));
}

/** Everything that can be wrong with an index, judged without touching a filesystem. */
export function parseIndex(
  manifestText: string,
  chunksText: string,
  vectorBytes: Uint8Array
): LoadedIndex {
  const manifest = parseIndexManifest(manifestText);
  if (manifest.vectorEncoding !== 'f32le') {
    throw new IndexDamagedError(`unsupported vector encoding ${String(manifest.vectorEncoding)}`);
  }
  // Both files are hashed into the manifest as they are written, and the manifest is renamed into
  // place last. Checking the hashes is what makes that ordering a commit: any file that arrived
  // without the manifest, or a manifest that arrived without its files, is caught here instead of
  // serving vectors that no longer belong to the stored text.
  for (const [file, expected, actual] of [
    [CHUNKS_FILE, manifest.chunksSha256, chunksText],
    [VECTORS_FILE, manifest.vectorsSha256, vectorBytes],
  ] as const) {
    if (expected !== undefined && sha256(actual) !== expected) {
      throw new IndexDamagedError(
        `index ${manifest.name} is inconsistent: ${file} is not the file the manifest was written with`
      );
    }
  }
  const lines = chunksText.split('\n').filter((l) => l.length > 0);
  const chunks = lines.map((l, i) => parseJson<ChunkRecord>(l, `${CHUNKS_FILE} line ${i + 1}`));
  let vectors: Float32Array;
  try {
    vectors = decodeVectors(vectorBytes, manifest.dimensions);
  } catch (err) {
    throw new IndexDamagedError((err as Error).message, { cause: err });
  }
  if (vectors.length !== chunks.length * manifest.dimensions) {
    throw new IndexDamagedError(
      `index ${manifest.name} is inconsistent: ${chunks.length} chunks, ${vectors.length / manifest.dimensions} vectors`
    );
  }
  // Older indexes carry no hashes, so the counts stay the check of last resort for them.
  if (manifest.chunkCount !== chunks.length) {
    throw new IndexDamagedError(
      `index ${manifest.name} is inconsistent: the manifest counts ${manifest.chunkCount} chunks, ${chunks.length} are stored`
    );
  }
  const rows = new Map<string, number>();
  for (const chunk of chunks) rows.set(chunk.doc, (rows.get(chunk.doc) ?? 0) + 1);
  for (const [rel, doc] of Object.entries(manifest.docs)) {
    const stored = rows.get(rel) ?? 0;
    if (stored !== doc.chunks) {
      throw new IndexDamagedError(
        `index ${manifest.name} is inconsistent: ${rel} is recorded with ${doc.chunks} chunks, ${stored} are stored`
      );
    }
    rows.delete(rel);
  }
  const [orphan] = rows.keys();
  if (orphan !== undefined) {
    throw new IndexDamagedError(
      `index ${manifest.name} is inconsistent: ${orphan} has rows but no record`
    );
  }
  return { manifest, chunks, vectors };
}

/** `undefined` when the directory holds no manifest; a damaged index throws `IndexDamagedError`. */
export async function readIndex(fs: LassiFs, dir: string): Promise<LoadedIndex | undefined> {
  const api = pathApi(dir);
  const manifestPath = api.join(dir, MANIFEST_FILE);
  if (!(await fs.exists(manifestPath))) return undefined;
  const chunksPath = api.join(dir, CHUNKS_FILE);
  const vectorsPath = api.join(dir, VECTORS_FILE);
  // Past the manifest, a missing file is damage rather than an absent index: the manifest is the
  // pointer, and it is not written until the other two are in place.
  for (const [file, path] of [
    [CHUNKS_FILE, chunksPath],
    [VECTORS_FILE, vectorsPath],
  ] as const) {
    if (!(await fs.exists(path))) {
      throw new IndexDamagedError(`index at ${dir} is missing ${file}`);
    }
  }
  return parseIndex(
    await fs.readFile(manifestPath),
    await fs.readFile(chunksPath),
    await fs.readBytes(vectorsPath)
  );
}

/** Each file lands via a temporary name and a rename, so a crash never leaves a half-written index. */
export async function writeIndex(fs: LassiFs, dir: string, index: LoadedIndex): Promise<void> {
  const api = pathApi(dir);
  // An index of zero-width vectors writes cleanly and can never be read back, so it is refused at
  // the point of writing as well as where it is built: the library export has no CLI guard in front.
  if (!Number.isInteger(index.manifest.dimensions) || index.manifest.dimensions <= 0) {
    throw new Error(
      `refusing to write index ${index.manifest.name} with ${index.manifest.dimensions} dimensions`
    );
  }
  await fs.mkdir(dir);
  const chunks =
    index.chunks.map((c) => JSON.stringify(c)).join('\n') + (index.chunks.length > 0 ? '\n' : '');
  const le = encodeVectors(
    Array.from({ length: index.chunks.length }, (_, r) =>
      index.vectors.subarray(r * index.manifest.dimensions, (r + 1) * index.manifest.dimensions)
    ),
    index.manifest.dimensions
  );
  // The manifest is the pointer: it names the model, the dimensions and the hashes of the two files
  // a reader checks against, so it is renamed into place last. Landing it first would leave a
  // permanently unreadable index behind a failed vector write.
  const manifest = `${JSON.stringify({ ...index.manifest, chunksSha256: sha256(chunks), vectorsSha256: sha256(le) }, null, 2)}\n`;
  const files = [
    [VECTORS_FILE, le],
    [CHUNKS_FILE, chunks],
    [MANIFEST_FILE, manifest],
  ] as const;
  const tmpOf = (name: string): string => api.join(dir, `${name}.tmp`);
  try {
    // Every file is written before any of them is renamed, so a write that runs out of space cannot
    // publish new vectors under the old manifest: that reads as damage and costs a full re-embed.
    // The renames then run back to back with nothing fallible between them.
    for (const [name, content] of files) {
      if (typeof content === 'string') await fs.writeFile(tmpOf(name), content);
      else await fs.writeBytes(tmpOf(name), content);
    }
    for (const [name] of files) await fs.rename(tmpOf(name), api.join(dir, name));
  } catch (err) {
    // A failed write leaves a partial temporary behind; nothing else would ever reclaim it.
    for (const [name] of files) await fs.unlink(tmpOf(name)).catch(() => undefined);
    throw err;
  }
}
