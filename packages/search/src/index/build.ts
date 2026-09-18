import { LassiError } from '@wonna/lassi-core';
import type { ChunkedDocument } from '../chunk/chunk.js';
import { normalize } from '../query/similarity.js';
import { indexMismatch, indexMismatchError } from './compat.js';
import { sha256 } from './hash.js';
import type { ChunkRecord, IndexedDoc, LoadedIndex } from './store.js';
import type { CorpusProvenance, DocumentOrigin } from './provenance.js';

export interface DocInput {
  /** Stable path supplied by the caller; the document's identity in the index. */
  rel: string;
  markdown: string;
  origin?: DocumentOrigin;
}

export interface IndexPlan {
  /** Unchanged documents whose rows are copied from the previous index. */
  reuse: string[];
  /** New or changed documents that need embedding. */
  embed: string[];
  /** Documents that disappeared from the input. */
  drop: string[];
}

/**
 * By content hash: unchanged rows are copied, changed documents embedded, missing ones dropped.
 * A rebuild embeds every document, but still reports what it drops: the caller previews that.
 */
export function planIndex(
  previous: LoadedIndex | undefined,
  docs: DocInput[],
  opts: { rebuild?: boolean; chunkFingerprint?: string } = {}
): IndexPlan {
  const plan: IndexPlan = { reuse: [], embed: [], drop: [] };
  const seen = new Set<string>();
  for (const doc of docs) {
    // Overlapping source directories can offer the same file twice; indexing it twice would
    // duplicate its rows, double the embedding cost and skew every score.
    if (seen.has(doc.rel)) continue;
    seen.add(doc.rel);
    const before =
      opts.rebuild === true ||
      (opts.chunkFingerprint !== undefined &&
        opts.chunkFingerprint !== previous?.manifest.chunkFingerprint)
        ? undefined
        : previous?.manifest.docs[doc.rel];
    if (before && before.sha256 === sha256(doc.markdown)) plan.reuse.push(doc.rel);
    else plan.embed.push(doc.rel);
  }
  for (const rel of Object.keys(previous?.manifest.docs ?? {}))
    if (!seen.has(rel)) plan.drop.push(rel);
  return plan;
}

export interface BuildIndexInput {
  name: string;
  model: string;
  corpus?: CorpusProvenance;
  chunkFingerprint?: string;
  /** Embed every document again and accept a model or width change, keeping the index's identity. */
  rebuild?: boolean;
  /** Configured `embeddings.dimensions`, checked against the index even when nothing is embedded. */
  dimensions?: number;
  previous: LoadedIndex | undefined;
  docs: DocInput[];
  /** A plan already computed from the same `previous`, `docs` and `rebuild`; recomputed if absent. */
  plan?: IndexPlan;
  chunk: (markdown: string, rel: string) => ChunkedDocument;
  /** Returns one vector per text, in order. */
  embed: (texts: string[]) => Promise<Float32Array[]>;
  now: () => Date;
}

export interface BuildStats {
  documents: number;
  reused: number;
  embedded: number;
  dropped: number;
  chunks: number;
  /** Chunks that went to the embeddings endpoint (also the number of texts sent). */
  embeddedChunks: number;
}

/**
 * Incremental rebuild: rows of unchanged documents are copied from the previous index, the rest
 * embedded in one call (the client batches), and the whole index is written anew by the caller.
 * Vectors are unit-normalised here so a query is a dot product.
 */
export async function buildIndex(
  input: BuildIndexInput
): Promise<{ index: LoadedIndex; stats: BuildStats }> {
  const { previous } = input;
  // A rebuild is exactly the permission to cross this gate; everything else it keeps.
  const configured =
    input.rebuild || !previous
      ? undefined
      : indexMismatch(previous.manifest, {
          model: input.model,
          ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
        });
  if (configured) {
    throw configured.kind === 'model'
      ? indexMismatchError(
          `index "${input.name}" was built with model ${configured.was}, the configuration now says ${configured.now}`,
          configured,
          'rebuild the index from scratch, or build under another name; vectors from different models cannot be mixed'
        )
      : indexMismatchError(
          `index "${input.name}" holds ${configured.was}-dimensional vectors, the configuration now asks for ${configured.now}`,
          configured,
          'rebuild the index from scratch, or build under another name; vectors of different widths cannot be compared'
        );
  }
  // The CLI computes the same plan for its --dry-run preview, and planIndex hashes every document
  // already in the index. Taking it back saves a second pass over the whole corpus and guarantees
  // the preview and the build agree on what gets embedded.
  const plan =
    input.plan ??
    planIndex(previous, input.docs, {
      rebuild: input.rebuild === true,
      ...(input.chunkFingerprint === undefined ? {} : { chunkFingerprint: input.chunkFingerprint }),
    });
  const byRel = new Map(input.docs.map((d) => [d.rel, d]));
  const chunked = new Map<string, ChunkedDocument>();
  const texts: string[] = [];
  for (const rel of plan.embed) {
    const doc = input.chunk((byRel.get(rel) as DocInput).markdown, rel);
    chunked.set(rel, doc);
    for (const c of doc.chunks) texts.push(c.embedText);
  }
  const fresh = texts.length > 0 ? await input.embed(texts) : [];
  if (fresh.length !== texts.length) {
    throw new LassiError(
      'validation',
      `embeddings endpoint returned ${fresh.length} vectors for ${texts.length} inputs`
    );
  }
  const dims = fresh[0]?.length ?? previous?.manifest.dimensions ?? 0;
  // Zero width happens when there is nothing to embed and no previous index to inherit from. Such
  // an index writes cleanly and can never be read back, so it is refused here rather than stored.
  if (dims <= 0) {
    throw new LassiError(
      'validation',
      `nothing to index under "${input.name}": no documents were embedded and there is no previous index to take the vector width from`,
      { hint: 'pass at least one document, or check that the source directory holds markdown' }
    );
  }
  // The width the endpoint chose is only knowable once it has answered, so this gate is the one
  // that cannot be moved ahead of the spending; without `embeddings.dimensions` pinned it is also
  // the only one that fires when a model quietly changes width under the same name.
  const returned =
    input.rebuild || !previous || fresh.length === 0
      ? undefined
      : indexMismatch(previous.manifest, { dimensions: dims });
  if (returned) {
    throw indexMismatchError(
      `index "${input.name}" has ${returned.was}-dimensional vectors, the endpoint now returns ${returned.now}`,
      returned,
      'rebuild the index from scratch, build under another name, or pin embeddings.dimensions'
    );
  }
  for (const [i, v] of fresh.entries()) {
    if (v.length !== dims) {
      throw new LassiError(
        'validation',
        `embedding ${i} has ${v.length} dimensions, expected ${dims}`
      );
    }
  }

  const chunks: ChunkRecord[] = [];
  const vectors: Float32Array[] = [];
  const docs: Record<string, IndexedDoc> = {};
  const stamp = input.now().toISOString();
  // Previous rows by document, in order, for the reused documents. A rebuild reuses nothing, so it
  // never pays for this pass over the old index.
  if (previous && plan.reuse.length > 0) {
    const rowsByDoc = new Map<string, number[]>();
    previous.chunks.forEach((c, row) => {
      const rows = rowsByDoc.get(c.doc) ?? [];
      rows.push(row);
      rowsByDoc.set(c.doc, rows);
    });
    for (const rel of plan.reuse) {
      for (const row of rowsByDoc.get(rel) ?? []) {
        chunks.push(previous.chunks[row] as ChunkRecord);
        vectors.push(previous.vectors.subarray(row * dims, (row + 1) * dims));
      }
      const { origin: _oldOrigin, ...before } = previous.manifest.docs[rel] as IndexedDoc;
      const origin = byRel.get(rel)?.origin;
      docs[rel] = { ...before, ...(origin === undefined ? {} : { origin }) };
    }
  }
  let cursor = 0;
  for (const rel of plan.embed) {
    const doc = chunked.get(rel) as ChunkedDocument;
    for (const c of doc.chunks) {
      chunks.push({
        doc: rel,
        ordinal: c.ordinal,
        product: doc.meta.product,
        ref: doc.meta.ref,
        title: doc.meta.title,
        heading: c.heading,
        text: c.text,
        ...(doc.meta.url === undefined ? {} : { url: doc.meta.url }),
      });
      vectors.push(normalize(fresh[cursor] as Float32Array));
      cursor += 1;
    }
    docs[rel] = {
      sha256: sha256((byRel.get(rel) as DocInput).markdown),
      chunks: doc.chunks.length,
      product: doc.meta.product,
      ref: doc.meta.ref,
      title: doc.meta.title,
      indexedAt: stamp,
      ...((byRel.get(rel) as DocInput).origin === undefined
        ? {}
        : { origin: (byRel.get(rel) as DocInput).origin }),
    };
  }
  const flat = new Float32Array(vectors.length * dims);
  vectors.forEach((v, row) => flat.set(v, row * dims));
  const index: LoadedIndex = {
    manifest: {
      schema: 1,
      name: input.name,
      model: input.model,
      dimensions: dims,
      vectorEncoding: 'f32le',
      // A rebuild replaces what an index holds, not the index: its age tells a reader whether the
      // export behind it is stale, so it survives.
      createdAt: previous?.manifest.createdAt ?? stamp,
      updatedAt: stamp,
      chunkCount: chunks.length,
      ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
      ...(input.chunkFingerprint === undefined ? {} : { chunkFingerprint: input.chunkFingerprint }),
      docs,
    },
    chunks,
    vectors: flat,
  };
  return {
    index,
    stats: {
      documents: plan.reuse.length + plan.embed.length,
      reused: plan.reuse.length,
      embedded: plan.embed.length,
      dropped: plan.drop.length,
      chunks: chunks.length,
      embeddedChunks: texts.length,
    },
  };
}
