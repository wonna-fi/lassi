---
title: Search Index
type: concept
last_verified: 2026-09-19
sources:
  - packages/search/package.json
  - packages/search/src/index.ts
  - packages/search/src/chunk/chunk.ts
  - packages/search/src/embeddings/client.ts
  - packages/search/src/index/{build,compat,store,provenance}.ts
  - packages/search/src/query/{query,similarity}.ts
  - packages/core/src/config/schema.ts
---

# Search Index

## Business Definition

A search index is a local, named semantic snapshot of exported Jira and Confluence Markdown. It records which files were indexed, where they came from, searchable text chunks, and compatible embedding vectors; it does not search attachments or live Atlassian data.

## Configuration

| Source | Description |
|--------|-------------|
| `storage.indexDir` | Root directory for named indexes; each index occupies `<indexDir>/<name>`. |
| `embeddings.model` and `embeddings.dimensions` | Define the vector space recorded in the manifest. |
| `embeddings.chunkChars` and `embeddings.chunkOverlap` | Shape chunks and contribute to the stored chunk fingerprint. |
| `embeddings.minScore` | Sets the query similarity floor; it is not persisted in the index. |

**How to access:**

- `readIndex()` - reads and validates the manifest, chunk records, and vector matrix.
- `readIndexManifest()` - reads source identity without requiring intact chunk or vector files.
- `queryIndex()` - returns the best qualifying chunk from each matching document.
- `MANIFEST_FILE` (constant) - names `manifest.json`.
- `CHUNKS_FILE` (constant) - names `chunks.jsonl`.
- `VECTORS_FILE` (constant) - names `vectors.f32`.

Configuration precedence and credential resolution belong to [Runtime Context](./runtime-context.md).

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `IndexManifest` | `schema`, `name`, `model`, `dimensions`, `vectorEncoding` | Identifies the format and vector space. Schema 1 uses little-endian float32 rows. |
| `IndexManifest` | `createdAt`, `updatedAt`, `chunkCount` | Records index age and expected row count. |
| `IndexManifest` | `docs` | Maps each stable absolute document path to its hash, chunk count, product, timestamps, and optional origin. |
| `IndexManifest` | `corpus`, `chunkFingerprint` | Records source coverage and the chunking configuration identity. |
| `IndexManifest` | `chunksSha256`, `vectorsSha256` | Binds the published manifest to its data files. |
| `IndexedDoc` | `sha256`, `chunks`, `product`, `ref`, `title` | Describes one indexed Markdown document. |
| `DocumentOrigin` | `manifest`, `fetchedAt`, `checkedAt`, `query`, `locallyModified` | Connects a document to an export manifest and its local-edit state. |
| `CorpusProvenance` | `sources`, `exports` | Identifies scanned directories and captured export runs. |
| `ExportProvenance` | `product`, `source`, `mode`, `queries`, `lastRun` | Describes the known scope and completeness of an export. |
| `ChunkRecord` | `doc`, `ordinal`, `product`, `ref`, `title`, `heading`, `text`, `url` | Stores searchable evidence and its document location. |
| `LoadedIndex` | `manifest`, `chunks`, `vectors` | Keeps metadata and row-major vectors aligned in memory. |
| `QueryHit` | `ChunkRecord` fields, `score` | Adds cosine similarity to a result chunk. |

Every document has a metadata chunk, so a bodyless issue or page remains searchable. Body chunks retain their original Markdown, heading path, ordinal, and offsets during construction. Text sent for embedding adds the title and heading context, but the stored result text remains the source chunk.

Document metadata comes from working-file frontmatter. An explicit `lassi.product` wins; otherwise an issue `key` implies Jira, while an `id` with a `title` implies Confluence. The reference is the issue key, page ID, or caller-provided fallback path, and the title prefers `summary`, then `title`, then the reference.

The metadata chunk includes the product, reference, title, and searchable scalar facts such as type, status, priority, assignee, labels, space, and parent. Its offsets are zero because it is synthesized from frontmatter rather than copied from the Markdown body.

Body sections begin at headings of depth one through three. Their heading path is joined with ` > ` and prefixed to the embedded text, preserving context for short passages. Oversized sections prefer a blank-line boundary in the latter half of the size window; otherwise they split at the hard limit.

The manifest is the commit pointer. Its chunk and vector counts must agree, every document's recorded chunk count must match its rows, and no row may refer to an unrecorded document. New indexes also hash both data files so mixed generations or partial publication are rejected as damage.

Corpus provenance describes local evidence, not server freshness. A complete export run is complete only for its recorded query; local source checks can report current, changed, unavailable, or unknown without claiming that Jira or Confluence itself is current.

`locallyModified` is three-valued: `false` means the current Markdown hash matches its export baseline, `true` means it differs, and `null` means an older exporter saved no baseline. Missing origin data makes no claim about modification.

Query hits deliberately point back to documents rather than becoming a second content store. The `doc` path identifies the exported Markdown, `url` may identify the remote item, and the chunk's title, heading, and text explain why it matched.

Named indexes are independent snapshots. Their name selects a directory and appears in the manifest; it does not namespace document paths or alter scoring.

An absent manifest means no index; a present manifest with invalid or missing data means a damaged index.

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-search` | `chunkDocument()` | Turns frontmatter-backed Markdown into metadata and body chunks. |
| `@wonna/lassi-search` | `docMetaFromFrontmatter()` | Derives product, reference, title, and URL from working-file frontmatter. |
| `@wonna/lassi-search` | `planIndex()` | Classifies document paths for reuse, embedding, or removal. |
| `@wonna/lassi-search` | `buildIndex()` | Produces a complete in-memory index from documents and embeddings. |
| `@wonna/lassi-search` | `readIndex()` | Loads and validates the complete persisted index. |
| `@wonna/lassi-search` | `writeIndex()` | Publishes vectors, chunks, and the manifest through temporary files. |
| `@wonna/lassi-search` | `indexMismatch()` | Detects model or dimension incompatibility. |
| `@wonna/lassi-search` | `queryIndex()` | Ranks compatible vectors and returns document-deduplicated hits. |
| `@wonna/lassi-search` | `createEmbeddingsClient()` | Creates the OpenAI-compatible embedding boundary used by builds and queries. |

## Internal Implementation

- `packages/search/src/index/store.ts` writes explicit little-endian float32 values, making the binary matrix portable rather than dependent on host byte order.
- The manifest is renamed last after both data files. Publication uses separate renames, so a failure can leave mixed generations; readers reject missing, mismatched, or malformed data as damage. The old generation is not restored automatically.
- Stored vectors and query vectors are normalized to unit length. Their dot product is cosine similarity, while zero or non-finite vectors normalize to zero and cannot become hits.
- Model and dimensions jointly define compatibility. A vector from another model or width cannot be mixed with existing rows even when its document text is unchanged.

## Reference Implementations

- `packages/search/src/index/store.ts` - persisted schema validation, integrity checks, portable vectors, and durable publication.
- `packages/search/src/chunk/chunk.ts` - frontmatter identity, metadata chunks, heading-aware splitting, and overlap.
- `packages/search/src/index/provenance.ts` - corpus and export provenance shapes and runtime validation.
- `readIndex()` - reference for consumers that require a complete, trustworthy index.
- `queryIndex()` - reference for turning a query vector into evidence-bearing hits.

Import the search API from `@wonna/lassi-search`; see [TypeScript Modules](../conventions/typescript-modules.md) for package boundaries.

## Related Concepts

- [Markdown Document](./markdown-document.md)
- [Runtime Context](./runtime-context.md)
- The build and persistence flow is documented in [Search Indexing](../features/search-indexing.md).
- Ranking and result presentation are documented in [Search Querying](../features/search-querying.md).
