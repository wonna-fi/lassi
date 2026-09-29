---
title: "Feature: Search Querying"
type: feature
sources:
  - packages/search/package.json
  - packages/search/src/index.ts
  - packages/search/src/embeddings/client.ts
  - packages/search/src/index/{compat,store}.ts
  - packages/search/src/query/{query,similarity}.ts
  - packages/cli/src/commands/search/{index,corpus,shared}.ts
  - packages/cli/src/cli.ts
  - packages/cli/src/commands/shared/storage.ts
  - packages/cli/src/evaluation/{metrics,retrieval}.ts
  - packages/core/src/config/schema.ts
---

# Feature: Search Querying

## Overview

Search querying embeds a question, compares it with a named local index, and returns the strongest evidence chunk from each matching exported document. Results include paths and provenance so callers can judge freshness and open the source.

## Key Concepts

Before working with this feature, understand these concepts:
- [Search Index](../concepts/search-index.md)
- Index creation and compatibility are covered by [Search Indexing](./search-indexing.md).
- Output and error behavior follow [Command Execution](./command-execution.md).

## Functional Specification

### Mechanism

1. `lassi search query <text>` validates the result limit, product filter, and index name.
2. It reads the complete index between storage-idle checks; a concurrent publication can trigger one retry, while persistent damage gets a rebuild hint.
3. The command checks the configured model and optional dimensions against the manifest before sending the question.
4. The embedding client sends the question as one input and requires one finite, non-empty vector.
5. `queryIndex()` checks the returned width, normalizes the query, and computes dot products against every unit-normalized row.
6. Rows are visited by descending score with stable row-order ties. Non-positive and below-threshold scores stop the scan.
7. The optional product filter is applied, then only the first—therefore best—chunk for each document is retained until the limit is reached.
8. Markdown renders a result table, per-hit provenance, and corpus coverage. JSON returns full evidence; AXI truncates snippets and includes an open-source next step.

### Validation Rules

- `--limit` must be a positive finite number; the default is 10.
- `--product` is either `jira` or `confluence`.
- The query model and vector width must match the index.
- A score must be positive and at least `embeddings.minScore` to qualify.
- At most one result is returned per document, even when several chunks score highly.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No named index exists | The command points to export and index commands and exits as usage failure. |
| No hit reaches the floor | Output reports the exact threshold and suggests other words, a lower score, or more exports. |
| Query vector is zero or non-finite after normalization | It produces no positive match rather than arbitrary rows. |
| Endpoint width differs from the manifest | The query is refused with a named rebuild hint. |
| Local sources changed after indexing | Hits are still returned, but coverage reports `changed`. |
| Local sources cannot be checked | Coverage reports `unavailable` without invalidating the stored index. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `QueryOptions` | `limit`, `minScore`, `product` | Controls ranking and filtering. |
| `QueryHit` | chunk fields, `score` | Couples the best evidence chunk with cosine similarity. |
| `CorpusStatus` | `localState`, `indexedAt`, `sources`, `exports`, `note` | Qualifies what the result corpus is known to cover. |

### Services and functions

The package-public interfaces used by this mechanism are owned by the [Search Index](../concepts/search-index.md) concept.

### CLI Commands

| Command | Purpose |
|-----------|---------|
| `lassi search query <text>` | Return semantic matches from the default index. |
| `lassi search query <text> --limit <N>` | Limit distinct documents returned. |
| `lassi search query <text> --product <jira\|confluence>` | Restrict results to one product. |
| `lassi search query <text> --index <name>` | Query another named index. |
| `lassi search show --index <name>` | Inspect model, dimensions, counts, dates, product mix, and local coverage. |

### API Calls

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/embeddings` | POST | Embed the query in the index's vector space. |

## Integration Points

- **Depends on**: A readable index from [Search Indexing](./search-indexing.md), embedding configuration, and an injected OpenAI-compatible client.
- **Used by**: CLI users and agents locating exported Jira issues or Confluence pages; retrieval evaluation also measures recall at 5 and 10, exact top-1, false-positive rates, irrelevant hits at 10, and recall by language.
- **External systems**: The configured embedding endpoint receives the query text; Jira and Confluence are not contacted.

## Extension Guide

Add ranking or filtering inside `queryIndex()` so library and CLI callers share one rule. Preserve best-first ordering and one-hit-per-document unless the public result contract deliberately changes.
Expose new evidence in the full JSON hit first, then decide what belongs in the compact AXI row and Markdown table. Always retain the document path, score, source identity, and coverage warning needed to inspect a result.
