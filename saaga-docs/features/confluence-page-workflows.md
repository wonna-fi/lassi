---
title: "Feature: Confluence Page Workflows"
type: feature
sources:
  - packages/cli/src/commands/shared/{storage,export-manifest}.ts
  - packages/confluence/package.json
  - packages/confluence/src/index.ts
  - packages/cli/src/commands/confluence/*.ts
  - packages/confluence/src/client/*.ts
  - packages/confluence/src/page/*.ts
  - packages/confluence/src/stats/macros.ts
---

# Feature: Confluence Page Workflows

## Overview

Confluence workflows let users find, inspect, export, create, validate, and safely update pages, work with footer comments and attachments, and measure macro usage without exposing storage XHTML as the normal editing format.

## Key Concepts

Before working with this feature, understand these concepts:

- [Confluence Domain](../concepts/confluence-domain.md)
- [Working File](../concepts/working-file.md)
- [Markdown Document](../concepts/markdown-document.md)

## Functional Specification

### User Flow

1. Identify a page by numeric ID, `SPACE:Title`, supported URL, or search it with CQL; `tree` explores its hierarchy.
2. Run `page get` to print canonical Markdown or save a working file. Optional comments and attachment metadata become generated sections.
3. Edit only the page body, title, or parent in a writable Markdown working file; storage output has no cache and view output is read-only.
4. Follow the shared validation and refresh sequence in [Working File Lifecycle](./working-file-lifecycle.md); Confluence additionally requires an unchanged numeric page version.
5. With valid cached storage, conversion reuses its users and editor shapes. A changed body must pass the fidelity check unless `--force` is given. Without that storage, the command warns, skips the check, and treats a supplied body as changed.
6. A successful update increments the Confluence version; `--keep` suppresses the normal working-file refresh.
7. Use comment commands for footer discussion, attachment download for files, and macro statistics to see unsupported content and prevalent editor forms.

Archive export searches a space or CQL and writes `<ID>.md` snapshots for offline use and search indexing. Its conflict-safe manifest lifecycle is documented in [Working File Lifecycle](./working-file-lifecycle.md).

### Validation Rules

- `page get --format` accepts `md`, `storage`, or `view`; view files cannot be written back.
- Page creation requires a space and title from flags, file frontmatter, or the configured default space.
- Update requires an ID or working file and at least one supported change; a file ID must match an explicit ID.
- Working-file update requires the exact path's cache state and rejects edited generated sections or mismatched declared versions.
- A remote version change after fetch is a conflict; changing space or removing a parent is unsupported.
- Unknown frontmatter keys are rejected; only title and parent are mutable page fields.
- Authored Markdown must not contain unfenced storage syntax, and `@username` mentions must resolve.
- Comment deletion accepts only a comment resource; body input is mutually exclusive across inline, file, and stdin sources.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Raw storage is requested with `--out` | Writes XHTML directly with no working-file cache. |
| View format is requested | Converts rendered HTML for reading and records a read-only format. |
| Cached storage XML is missing or fails its hash | Warns and skips the fidelity gate. A supplied file body is treated as changed and included in the update even if it was not edited. |
| A title-only file edit has valid cached storage | Converts the supplied body but omits it from the update when it matches the cached Markdown; the fidelity gate is not needed. |
| No supported field or body changed, with valid cached storage | Reads live page metadata, then reports no changes and sends no update. Missing cached storage prevents this body comparison. |
| Search or hierarchy reaches a hard cap | Returns the prefix and warns which cap stopped traversal. |
| An attachment exceeds the byte limit | Reports it as skipped without saving it. |
| Every selected attachment download fails | Returns the per-file results with exit code 1. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `PageFrontmatter` | `id`, `title`, `space`, `parent`, `readonly`, `counts`, `lassi` | Separates editable page fields from fetched metadata. |
| `PageFileState` | `version`, `parent`, `sections`, `storageSha256`, `format` | Preserves the baseline for one working-file path. |
| `PageObservation` | `id`, `macros`, `shapes`, `warnings` | Captures one page for macro and dialect statistics. |

### Services and functions

The client, editable fields, and statistics interfaces are described in [Confluence Domain](../concepts/confluence-domain.md). The `checkFidelity()` conversion check is described in [Confluence Storage Conversion](./confluence-storage-conversion.md).

### CLI Commands

| Command surface | Purpose |
|-----------|---------|
| `confluence page get <ref>` | Reads Markdown, storage, or rendered view; optionally saves a working file. |
| `confluence page create` / `validate` / `update` | Creates pages, asks the server to parse generated storage, or applies safe edits. |
| `confluence page export [CQL]` | Archives pages selected by CQL or space with manifest conflict protection. |
| `confluence search <CQL>` / `tree <ref>` | Finds content or walks a page hierarchy. |
| `confluence comment list`, `add`, `delete` | Reads and mutates footer comments. |
| `confluence attach get <PAGE_ID>` | Downloads selected attachments outside the context window. |
| `confluence stats macros` | Reports macro use, raw-fence reasons, and observed writer conventions. |

## Integration Points

- **Depends on**: [Command Execution](./command-execution.md), [Working File Lifecycle](./working-file-lifecycle.md), and [Confluence Storage Conversion](./confluence-storage-conversion.md).
- **Used by**: People and agents maintaining Confluence content, plus semantic indexing of page exports.
- **External systems**: Confluence Data Center REST content, search, user, body-conversion, and attachment endpoints.

## Extension Guide

Add remote behavior to `ConfluenceClient` and export it through the package barrel before registering a command from the Confluence namespace. Resolve page references through the shared client, use injected I/O, classify remote mutations as writes, and call the write guard immediately before sending.

For page edits, keep mutable fields explicit, retain a per-path baseline, and compare the live version. Use valid cached storage to determine whether the body was edited; without it, the current command sends any supplied body. New body syntax belongs in the conversion feature; unsupported syntax must remain fenced until both read and write directions preserve it.

For new bulk reads, expose truncation rather than implying completeness. For new downloads, stream to disk, apply configured limits, sanitize server filenames, and report partial failures per item.

Preserve the distinction between remote effects and local output: page export and attachment download are read commands even though they write files. Mutations must remain behind both command classification and the late write guard.

When extending macro statistics, aggregate observations in the library and keep scope selection, limits, warnings, and rendering in the CLI command.
