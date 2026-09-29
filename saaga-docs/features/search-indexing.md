---
title: "Feature: Search Indexing"
type: feature
sources:
  - packages/search/package.json
  - packages/search/src/index.ts
  - packages/search/src/index/provenance.ts
  - packages/cli/src/commands/shared/export-manifest.ts
  - packages/search/src/chunk/chunk.ts
  - packages/search/src/embeddings/client.ts
  - packages/search/src/index/{build,compat,hash,store}.ts
  - packages/cli/src/commands/search/{index,corpus,shared}.ts
  - packages/cli/src/cli.ts
  - packages/cli/src/commands/shared/storage.ts
  - packages/core/src/config/*.ts
  - packages/core/src/http/*.ts
---

# Feature: Search Indexing

## Overview

Search indexing turns exported Markdown into a durable local semantic index. Callers can update only changed documents, preview embedding cost without sending text, or rebuild every vector after a model, dimension, chunking, or integrity change.

## Key Concepts

Before working with this feature, understand these concepts:

- [Search Index](../concepts/search-index.md)
- [Markdown Document](../concepts/markdown-document.md)
- Command safety and dry runs follow [Command Execution](./command-execution.md).

## Functional Specification

### Mechanism

1. `lassi search index [dir...]` validates the index name and ensures the target cannot overlap an export or supplied source directory.
2. Under the shared storage lock, it reads the prior index. `--rebuild` may treat damaged index data as absent, but filesystem failures remain fatal.
3. With no supplied directories, it reuses recorded corpus sources, then falls back to existing global Jira and Confluence export directories for a new index.
4. `collectCorpus()` recursively reads `*.md`, resolves symlinked directory identity, deduplicates stable absolute paths, and captures valid export-manifest provenance.
5. A second source snapshot check rejects an export that changed during the scan, preserving the existing index.
6. The command loads embedding configuration and refuses a known model or configured-dimension mismatch before previewing or sending text unless rebuilding.
7. It hashes the chunking revision, maximum size, and overlap. `planIndex()` marks unchanged compatible documents for reuse, new or changed documents for embedding, and missing documents for removal.
8. Each selected document becomes one metadata chunk plus heading-aware body chunks. Oversized sections split at blank lines when possible and carry bounded character overlap.
9. The dry-run preview reports documents, chunks, approximate characters, reuse and removal counts, model, endpoint, and destination; it sends nothing.
10. The embedding client batches `embedText` through the configured OpenAI-compatible `/embeddings` endpoint and validates count, finite values, and consistent dimensions.
11. `buildIndex()` copies reusable rows, normalizes new vectors, and assembles records in current document order with updated provenance and timestamps.
12. `writeIndex()` writes all temporary files, renames vectors and chunks, then publishes the hash-bearing manifest last.

### Validation Rules

- `search index` is a write command. Read-only mode blocks it unless `--dry-run` is set, even when an incremental plan would reuse all existing vectors.
- Index names contain only letters, digits, `.`, `_`, and `-`; `.` and `..` are forbidden.
- At least one readable source directory must contain Markdown.
- The index target must not be inside, contain, or alias a source directory.
- A non-rebuild update requires the same embedding model and vector dimensions as the existing index.
- A changed chunk fingerprint forces every current document into the embed set.
- `maxChars` must be a positive integer; configuration also keeps overlap below the chunk size.
- One endpoint response must contain one non-empty, finite vector per input, in a consistent width.
- An unreadable source is an error, never evidence that its documents should be dropped.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Overlapping source roots expose one file twice | Its stable path is indexed once, using the closest export-manifest provenance. |
| A document has no body | Its metadata chunk still makes it searchable. |
| A heading is deeper than level three | It stays within the current section rather than starting a new heading path. |
| An unchanged document has compatible prior rows | Its chunk records and vectors are copied without an embedding request. |
| Endpoint width changes without configured dimensions | The late mismatch aborts publication and recommends `--rebuild` or another index name. |
| Existing index data is damaged with `--rebuild` | Source identity and creation time are recovered from the manifest when possible. |
| The rebuild fails during embedding or temporary writes | The prior published manifest remains in place; temporary files are cleaned up after write failure. |
| A legacy index stores relative paths | Shared use is refused until rebuilt from the original workspace with explicit sources. |

Source scanning follows symlink-resolved directory identities to avoid cycles. Paths stored in new indexes are absolute and portable in spelling, allowing a shared index root to be queried from another workspace without reinterpreting relative document identities.

An export-shaped `manifest.json` must pass the export manifest validator. Unrelated manifests are ignored, but malformed JSON or an invalid candidate stops indexing rather than silently discarding provenance.

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `DocInput` | `rel`, `markdown`, `origin` | Supplies stable identity, source content, and optional export evidence. |
| `ChunkedDocument` | `meta`, `chunks` | Holds searchable units for one Markdown file. |
| `IndexPlan` | `reuse`, `embed`, `drop` | Makes incremental work and dry-run cost explicit. |
| `BuildIndexInput` | `previous`, `docs`, `plan`, `chunk`, `embed` | Injects the pure and remote parts of index construction. |
| `BuildStats` | `documents`, `embedded`, `reused`, `dropped`, `chunks` | Reports the completed update. |

### Services and functions

The package-public interfaces used by this mechanism are owned by the [Search Index](../concepts/search-index.md) concept.

The builder accepts injected `chunk`, `embed`, and `now` functions. This keeps corpus planning and index assembly testable without a live endpoint, while the CLI owns configured clients, dry-run output, locking, and destination safety.

### CLI Commands

| Command | Purpose |
|-----------|---------|
| `lassi search index [dir...]` | Incrementally index supplied directories or remembered/default export roots. |
| `lassi search index --name <index>` | Build or update an independently named index. |
| `lassi search index --rebuild` | Re-embed the complete corpus and replace incompatible or damaged index data. |
| `lassi search index --dry-run` | Preview remote embedding work and local replacement without sending or writing. |

### API Calls

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/embeddings` | POST | Convert batches of contextualized chunk text into vectors. |

The request carries `model`, `input`, and optional `dimensions`; Azure-compatible configuration also adds `api-version`. It is marked idempotent so the shared HTTP layer may retry throttling responses. Input text is never logged.

Embedding responses may arrive out of order; the client sorts entries by their returned input index before validation. Batch size never falls below one, and every batch must preserve the same vector width as earlier batches.

## Integration Points

- **Depends on**: Exported working files, the [Search Index](../concepts/search-index.md), injected filesystem and HTTP services, and the shared storage lock.
- **Used by**: [Search Querying](./search-querying.md), which requires a compatible published index.
- **External systems**: An OpenAI-compatible embedding endpoint receives only chunks selected for embedding.

## Extension Guide

Add corpus metadata in `collectCorpus()` and the provenance types together, keeping paths stable and runtime validation backward compatible. Do not read Jira or Confluence from the search package; export commands own remote retrieval.

When changing chunk boundaries or embedded context, increment the fingerprint revision or alter its inputs so old rows cannot be silently reused. Keep the metadata chunk, because it is the only searchable representation of bodyless documents and structured frontmatter facts.

To support a new embedding provider, adapt it to the existing `EmbeddingsClient` contract. Preserve input order, finite consistent vectors, batching, injected HTTP, and the model/dimension compatibility gate.

Any new persistence field must be written and validated on read. Keep the manifest as the last commit point so interrupted publication is detected as damage; the sequential renames do not preserve the old index if a rename fails.

Keep incremental planning deterministic. Stable document ordering, content hashes, and explicit drop reporting make previews match completed work and prevent overlapping roots from inflating embedding cost or ranking weight.

Treat a new compatibility dimension like model and vector width: detect it before remote work when configuration exposes it, store enough identity to validate later, and require a rebuild when old and new rows cannot be compared safely.

Keep source reads within the storage snapshot checks. A scan must never translate a concurrent export, permission failure, or malformed manifest into document removals.

Preserve `createdAt` across successful updates and recover it during a repair when the old manifest remains readable.

When adding a new source type, supply Markdown and optional provenance through `DocInput`; do not bypass chunking with provider-specific vectors. The index remains product-neutral apart from the small `jira`, `confluence`, or `unknown` classification used for filtering.
