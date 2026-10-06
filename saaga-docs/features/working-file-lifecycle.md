---
title: "Feature: Working File Lifecycle"
type: feature
sources:
  - packages/core/src/index.ts
  - packages/jira/src/index.ts
  - packages/confluence/src/index.ts
  - packages/cli/src/commands/jira/export.ts
  - packages/cli/src/commands/confluence/export.ts
  - packages/core/src/markdown/{frontmatter,sections}.ts
  - packages/cli/src/workfile/*.ts
  - packages/cli/src/commands/shared/{storage,export-manifest,identifiers}.ts
  - packages/cli/src/commands/jira/{workfile,issue-write}.ts
  - packages/cli/src/commands/confluence/{workfile,page-write}.ts
  - packages/jira/src/issue/{frontmatter,cache,diff,document}.ts
  - packages/confluence/src/page/{frontmatter,cache,document}.ts
---

# Feature: Working File Lifecycle

## Overview

The lifecycle turns a fetched Jira issue or Confluence page into editable Markdown, remembers the snapshot that produced each path, sends only supported changes, and refreshes the file after a write. Bulk exports also track archive hashes and query coverage. They reuse the working-file writers, so exporting creates path-specific caches as well.

## Key Concepts

Before working with this feature, understand these concepts:

- [Working File](../concepts/working-file.md)
- [Markdown Document](../concepts/markdown-document.md)
- [Runtime Context](../concepts/runtime-context.md)

## Functional Specification

### Mechanism

1. A product command fetches an entity and converts its body through the canonical Markdown representation.
2. It places Jira fields according to [Jira Domain](../concepts/jira-domain.md), then builds frontmatter, `readonly`, `counts`, and schema-1 `lassi` metadata. Requested related content becomes generated sections.
3. `writeWorkingFile()` renders YAML and body, returning a SHA-256 content hash.
4. The command merges a snapshot, including the file's wiki-rendered field formats, into the entity cache under the file's displayed workspace-relative path.
5. Update reads the file, checks its entity identity, and requires cache state for that exact path.
6. Jira compares the live `updated` marker with the cached value only when `--if-unchanged` is set. Confluence always compares the live version with the cached version for a file-based update.
7. The generated tail is stripped only when unchanged. Generated content is never sent as the editable body.
8. Product diff logic determines which fields and body to send. Jira uses the file's recorded formats for conversion and rejects changed nonwritable top-level fields. Confluence converts a supplied body before comparing it with the cached Markdown. If cached storage is unavailable, it treats the body as changed; see [Confluence Page Workflows](./confluence-page-workflows.md).
9. The command write gate applies read-only and dry-run policy; see [Command Execution](./command-execution.md).
10. After a successful write, the command normally re-fetches and rewrites the file, preserving which generated sections it included. Jira refreshes an included comments section with all comments. `--keep` skips the refresh.

An export manifest records each server marker, path, content hash, and renderer settings. The Jira render hash includes field aliases and policy settings, so a changed policy can rerender even when the server marker is unchanged. A later export checks those values and comment completeness before reusing a file. It refuses to overwrite bytes that differ from the baseline. Archive writes use an exclusive lock, and manifests publish by temporary-file rename. For editable work, use `get --out` to keep a separate copy: editing an archive file causes a conflict on the next export.

Working-file refresh is not a transaction. The Markdown file is written before its cache, so a failed cache write can leave new Markdown paired with an older entry for the same path. Jira checks that the entry exists but does not compare a file hash or fetch timestamp with it. A later update can therefore interpret the refreshed content as edits against the old baseline. After a failed refresh, preserve any intended edits separately and fetch a fresh working copy before retrying. Archive locking and atomic manifest replacement do not make the file/cache pair atomic.

### Validation Rules

- A working file must exist, contain closed YAML frontmatter, and parse to a mapping.
- Its entity identifier must match the command target.
- Write-back requires cache state for the exact file path, not merely the same entity.
- Server issue keys and page IDs are validated before naming files.
- Edited generated sections cause refusal because they are informational.
- Removing a Jira YAML key warns and preserves the remote value; `null` explicitly clears a supported field.
- Jira edits inside `readonly` are ignored with warnings; changed nonwritable top-level fields fail, as do unknown editable fields.
- Confluence rejects unknown keys and immutable identity/space changes; title and parent are editable.
- Confluence view HTML is read-only input and cannot be an editable storage baseline.
- Export never overwrites an untracked file or one whose bytes differ from its manifest baseline.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Cache JSON is malformed | Treat it as missing and identify it in the recovery hint. |
| Another fetch wrote the same entity to a different path | The earlier path keeps its own snapshot. |
| A generated section changed | Refuse the update. |
| Comparison finds no supported change | Send no update and do not refresh the file. Jira fetches no edit metadata; Confluence still reads live page metadata and needs valid cached storage to recognize an unchanged file body. |
| Jira labels only changed order | Compare them as a set and send nothing. |
| The server changed after fetch | Jira reports a conflict when `--if-unchanged` is set; Confluence file updates always compare the live version. |
| Confluence body fidelity would be lost | Refuse a changed body unless its workflow's force option is used. |
| Export marker changed, local bytes did not | Render and write again, advancing the baseline. |
| Export bytes changed locally | Preserve the file and report a conflict summary. |
| A process holds the archive lock | Report a conflict; remove stale locks only after confirmation. |

Archive export currently acquires the archive lock and publishes manifest state even when global dry-run is set. Remote write previews and their safety behavior are owned by [Command Execution](./command-execution.md), while this feature owns what would be compared and refreshed.

## Technical Implementation

The persisted working-file and cache schemas are defined in [Working File](../concepts/working-file.md); this feature covers their lifecycle transitions.

### Services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-core` | `stripGeneratedSections()` | Separates editable content from the generated tail. |
| `@wonna/lassi-jira` | `frontmatterChanges()` | Lists changed fields, warnings, and body-change state before conversion, so update can tell whether edit metadata is needed. |
| `@wonna/lassi-confluence` | `diffEditableFields()` | Computes supported title and parent changes. |

### CLI Commands

| Command surface | Purpose |
|-----------|---------|
| `jira issue get … --out <file>` | Creates or refreshes a Jira working copy. |
| `jira issue update <KEY> --file <file>` | Diffs and writes supported Jira changes. |
| `confluence page get … --out <file>` | Creates or refreshes a Confluence working copy. |
| `confluence page update <ID> --file <file>` | Diffs and writes supported Confluence changes. |
| Jira/Confluence export commands | Maintain read-only archives and manifest baselines. |

The product workflow documents own exact command flags and product validation. This feature owns the shared fetch-to-cache-to-update state machine.

## Integration Points

- **Depends on**: [Command Execution](./command-execution.md), [Runtime Context](../concepts/runtime-context.md), and [Loss-Aware Conversion](../patterns/loss-aware-conversion.md).
- **Used by**: Jira issue workflows, Confluence page workflows, and semantic search over exported Markdown.
- **External systems**: Jira and Confluence REST APIs provide content and optimistic markers.

## Extension Guide

For another editable product, define frontmatter and cache schemas, convert the body through mdast, and store a snapshot per displayed file path. Split reserved metadata before diffing, validate identifiers before path use, preserve generated sections as an exact cached tail, and check a service-native optimistic marker. Re-fetch after success to refresh both file and cache, and handle partial failures between those writes explicitly.

For export changes, include every byte-affecting renderer input in `exportRenderHash()`, validate the manifest before trusting baselines, and write under `withStorageLock()`. An export never sends local edits back to the service; it reports them as conflicts. Keep editable work in separate copies so it does not block later exports.
