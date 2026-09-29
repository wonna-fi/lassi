---
title: Working File
type: concept
sources:
  - packages/jira/package.json
  - packages/jira/src/index.ts
  - packages/confluence/package.json
  - packages/confluence/src/index.ts
  - packages/cli/src/commands/jira/{workfile,export,issue-write}.ts
  - packages/cli/src/commands/confluence/{workfile,export,page-write}.ts
  - packages/cli/src/workfile/*.ts
  - packages/cli/src/commands/shared/identifiers.ts
  - packages/cli/src/commands/shared/export-manifest.ts
  - packages/core/src/config/schema.ts
  - packages/core/src/config/load.ts
  - packages/jira/src/issue/{frontmatter,cache,diff}.ts
  - packages/confluence/src/page/{frontmatter,cache}.ts
last_verified: 2026-09-19
---

# Working File

## Business Definition

A working file is an editable Markdown snapshot of one Jira issue or Confluence page paired with cache state from the fetch that created that exact file. It lets an agent propose focused changes while Lassi distinguishes editable content, informational metadata, generated sections, and server drift.

## Configuration

| Source | Description |
|--------|-------------|
| `LassiConfig.attachments.dir` | Selects the workspace-relative attachment root. |
| `LassiConfig.storage.exportDir` | Selects the user-wide archive root, separate from editable working copies. |
| `LassiConfig.storage.indexDir` | Selects the user-wide semantic-index root. |
| `LoadedConfig.workspaceStateDir` | Selects the local state root, normally `<cwd>/.lassi`. |

**How to access:**

- `lassiDirs()` - resolves work, cache, attachment, export, and index locations.
- `readWorkingFile()` - reads a file and requires YAML frontmatter.
- `writeWorkingFile()` - renders the file and returns its SHA-256 content hash.
- `RESERVED_KEYS` (constant) - contains `readonly`, `counts`, and `lassi`.

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `WorkingFile` | `frontmatter`, `body` | Holds parsed YAML fields and the complete Markdown body. |
| `LassiMeta` | `fetchedAt`, `product`, `schema` | Identifies when, for which product, and under which schema the file was produced. |
| `LassiMeta` | `storageSha256`, `format` | Records Confluence source identity and whether the body came from storage or view HTML. |
| `SplitFrontmatter` | `editable` | Contains all top-level keys except the three reserved groups. |
| `SplitFrontmatter` | `readonly`, `counts`, `lassi` | Separates server facts, related-item counts, and Lassi metadata. |
| `IssueCache` | `editable`, `readonly`, `descriptionMarkdown` | Stores the Jira comparison baseline. |
| `IssueCache` | `fieldSchema`, `aliases`, `descriptionWiki` | Retains field conversion metadata and original Jira source. |
| `IssueFileState` | fetch snapshot, `updated`, `sections` | Keys one Jira baseline to one working-file path. |
| `PageCache` | `version`, `storageSha256`, `files` | Identifies Confluence storage and per-file baselines. |
| `PageFileState` | `parent`, `format`, `sections` | Retains page state and the generated tail for one file path. |

Top-level product fields are the editable area. Jira exposes issue fields and configured custom-field aliases; Confluence exposes identity, title, space, and parent, but only title and parent may change. Field meanings are described in [Jira Domain](./jira-domain.md) and [Confluence Domain](./confluence-domain.md).

`readonly` contains server facts displayed for context, `counts` summarizes related content, and `lassi` describes the snapshot. `splitEditable()` never treats those groups as update fields. Jira warns and ignores edits under `readonly`; Confluence validates its immutable fields before writing.

Cache identity has two parts: the server entity and the displayed path from the workspace root. A single entity may have several files fetched with different expansion options or at different times. A fetch to a different path preserves the earlier path's baseline; a successful fetch to the same path replaces it. This is path bookkeeping, not a transaction between the Markdown and cache writes. Failure recovery is described in [Working File Lifecycle](../features/working-file-lifecycle.md).

The shared drift vocabulary is:

| State | Meaning |
|-------|---------|
| editable change | A present top-level editable value differs deeply from its cached value. |
| deletion | A cached editable key is absent; Jira warns rather than treating absence as clearing. |
| readonly drift | A cached key under `readonly` differs in the file. |
| generated-section drift | The cached body tail no longer matches exactly and cannot be safely stripped. |
| server drift | Jira's `updated` marker or Confluence's version/storage identity moved after fetch. |
| missing baseline | Cache JSON is absent, damaged, or has no entry for this exact file path. |

Damaged JSON cache data is treated as no cache, with a callback allowing the command to give a useful recovery hint. Cache filenames accept only server-validated issue keys, project keys, decimal issue type IDs, or decimal content IDs, preventing an API response from escaping `.lassi/cache` through path traversal.

Bulk exports reuse the working-file writers and create path-specific caches. They also record content hashes in an archive manifest so a later export can detect local edits. The Jira cache itself contains no content hash. Use a separate `get --out` copy for editing to avoid archive conflicts; see [Working File Lifecycle](../features/working-file-lifecycle.md).

Directory roles remain separate:

| Location | Role |
|----------|------|
| `.lassi/work` | Default workspace area for editable copies. |
| `.lassi/cache/jira` | Jira JSON baselines keyed by validated issue key. |
| `.lassi/cache/jira/editmeta` | Jira edit metadata keyed by project key and issue type ID; the reuse rules are in [Jira Domain](./jira-domain.md). |
| `.lassi/cache/confluence` | Versioned storage XML and page JSON sidecars. |
| configured export root | User-wide archive input to search, with manifest-based protection for local edits. |

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-jira` | `buildIssueCache()` | Builds the Jira entity and file baseline. |
| `@wonna/lassi-confluence` | `pageToFrontmatter()` | Builds Confluence fields and snapshot metadata. |

## Internal Implementation

- Cache path construction validates identifiers before joining them beneath the state directory.
- JSON caches are published by temporary-file rename, so a concurrent reader sees the old or the new file and never a torn write.
- Deep comparison treats arrays as ordered and objects by the union of their keys; Jira handles labels separately as a set.
- Confluence stores exact storage XHTML in a versioned `.xml` file and generated sections plus fetch metadata in a JSON sidecar.

## Reference Implementations

- `packages/cli/src/workfile/schema.ts` - the shared editable/reserved split.
- `packages/cli/src/workfile/cache.ts` - safe cache names and damaged-cache behavior.
- `packages/jira/src/issue/cache.ts` - entity and per-file Jira baselines.
- `packages/confluence/src/page/cache.ts` - Confluence storage identity and per-file state.
- `readWorkingFile()` - reference for enforcing the working-file envelope.
- `splitEditable()` - reference for keeping reserved groups out of an update.

## Related Concepts

- [Markdown Document](./markdown-document.md)
- [Runtime Context](./runtime-context.md)
- State transitions and safety checks are documented in [Working File Lifecycle](../features/working-file-lifecycle.md).
