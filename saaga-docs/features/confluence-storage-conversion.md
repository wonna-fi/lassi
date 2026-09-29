---
title: "Feature: Confluence Storage Conversion"
type: feature
sources:
  - packages/cli/src/commands/confluence/{page,comment,stats}.ts
  - packages/confluence/src/stats/macros.ts
  - packages/confluence/package.json
  - packages/confluence/src/index.ts
  - packages/confluence/src/convert/**/*.ts
  - packages/cli/src/commands/confluence/{body,shared,page-write,workfile}.ts
  - fixtures/confluence/**
---

# Feature: Confluence Storage Conversion

## Overview

Confluence storage conversion translates writable storage XHTML and read-only rendered HTML into canonical Markdown, then writes edited Markdown back while preserving unsupported source and the page's observable editor conventions.

## Key Concepts

Before working with this feature, understand these concepts:

- [Markdown Document](../concepts/markdown-document.md)
- [Confluence Domain](../concepts/confluence-domain.md)
- The shared preservation approach is [Loss-Aware Conversion](../patterns/loss-aware-conversion.md).

## Functional Specification

### Mechanism

1. The storage reader parses an XHTML fragment with source ranges and walks block and inline elements into an mdast `Root`.
2. Supported structures become GFM or Confluence extension nodes; user keys resolve through a `UserDirectory` and unresolved keys remain explicit placeholders.
3. Any unsupported storage construct escalates to the nearest safe source slice, emitted as a fenced `confluence` code block with a positional warning.
4. The reader records table shells, cell wrappers, mention attributes, task bodies, and self-labelled-link forms as `PageShapes`.
5. Canonical Markdown serialization renders standard nodes plus page links, Jira macros, alerts, user-key placeholders, and table-of-contents comments.
6. Before writing, the CLI parses that dialect, rejects leaked storage markup, resolves authored mentions, and merges those mappings with cached page users.
7. The writer converts nodes to escaped storage XML, restores raw fences verbatim, and reports legal but lossy choices such as dropped metadata.
8. For an existing page, writer options use a majority vote over observed shapes so edited content follows the page's established forms; new pages use stable defaults.
9. When valid cached storage is available and the body changed, the fidelity gate reads and rewrites the cached original, canonicalizes both storage trees, and reports bounded positional differences. The CLI skips this check if the storage is missing or fails its hash; see [Confluence Page Workflows](./confluence-page-workflows.md) for the resulting body-write behavior.

Rendered view HTML follows a one-way variant of the reader. Unsupported view regions become ordinary `html` fences because view output is never a writable baseline.

### Validation Rules

- Storage input is an XML fragment, not a complete document; entity decoding and source slicing must preserve safe passthrough regions.
- Markdown writes reject unfenced `ac:`/`ri:` storage signatures detected outside literal code boundaries.
- Authored `@username` mentions must resolve; fetched `@{userkey:…}` placeholders survive without a username.
- A raw `confluence` fence is restored as storage; an `html` fence from view conversion is not.
- A page link title or body that cannot fit the Markdown extension grammar is fenced instead of altered.
- Unknown inline content fences its enclosing block so surrounding structure is not silently separated from it.
- Storage comparisons ignore representational differences defined by normalization, but retain semantic elements, attributes, text, comments, and processing instructions.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Unknown macro, styled span, layout, or unsupported table shape | Preserves the source region in a raw fence and emits a categorized warning. |
| Code macro has parameters but no language | Fences it because Markdown would discard its metadata. |
| Panel title contains a newline | Fences the macro because its Markdown marker must fit one line. |
| Mention key cannot be resolved on read | Emits a user-key placeholder and a `user-unresolved` warning. |
| Writer needs user keys but a username has no key | The write path refuses rather than inventing an identity. |
| A self-labelled URL was plain text in storage | The recorded/inferred autolink option prevents it becoming an anchor unintentionally. |
| Fidelity writing throws | Returns an unequal result with the error and no fabricated structural diff. |
| More than ten fidelity differences exist | Returns the first ten and marks the comparison truncated. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `ReadResult` | `tree`, `warnings`, `shapes` | Returns canonical mdast plus preservation evidence and writer hints. |
| `PageShapes` | `tableShells`, `cellWraps`, `mentionAttributes`, `taskBodies`, `autolinks` | Records storage forms Markdown cannot distinguish. |
| `StorageWriterOptions` | `tableShell`, `cellWrap`, `mentionAttribute`, `taskBody`, `autolink` | Selects concrete XML forms for ambiguous Markdown. |
| `ConverterWarning` | `code`, `name`, `path` | Identifies each fenced or unresolved read construct. |
| `StorageWarning` | `code`, `message`, `line` | Describes a writer decision that loses nonessential metadata. |
| `StorageDiff` | `path`, `kind`, `a`, `b` | Describes a canonical-tree mismatch for the fidelity gate. |

### Services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-confluence` | `createStorageConverter()` | Provides storage/Markdown/mdast directions and view rendering behind one adapter. |
| `@wonna/lassi-confluence` | `storageToMdast()` / `mdastToStorage()` | Implements the loss-aware storage reader and escaped writer. |
| `@wonna/lassi-confluence` | `viewToMdast()` | Reads rendered HTML into mdast without creating writable raw storage fences. |
| `@wonna/lassi-confluence` | `normalizeConfluenceMarkdown()` | Canonicalizes the extended Markdown dialect. |
| `@wonna/lassi-confluence` | `inferWriterOptions()` | Chooses each page-shape form by majority with stable defaults. |
| `@wonna/lassi-confluence` | `normalizeStorage()` / `compareStorage()` | Canonicalizes and structurally compares storage fragments. |
| `@wonna/lassi-confluence` | `checkFidelity()` | Tests the full storage-to-Markdown-to-storage round trip. |
| `packages/cli/src/commands/confluence/body.ts` | `markdownBodyToStorage()` | Applies leak detection, mention validation, directories, and write warnings. |

The dialect represents common headings, paragraphs, lists, task lists, tables, formatting, links, images, attachment references, mentions, code/noformat blocks, panel alerts, TOC markers, and keyed Jira macros. Syntax details are exercised by the fixture corpus; structures outside that supported set remain source fences rather than implied support.

Writer defaults use a plain table shell, unwrapped cells, user-key mentions, placeholder-wrapped task bodies, and plain-text self-labelled URLs. For updates with valid cached storage, that storage supplies the user directory and inferred options. Without it, conversion uses the defaults and cannot recover the original editor forms.

The Markdown extensions carry information standard GFM cannot express:

| Form | Meaning |
|------|---------|
| `[[Title]]` / `[[SPACE:Title\|label]]` | A Confluence page link, optionally in another space or with display text. |
| `@username` | A resolved mention; `@{userkey:key}` preserves an unresolved fetched identity. |
| `[!NOTE]`, `[!TIP]`, `[!WARNING]`, `[!IMPORTANT]` | Supported rich-text panel macros, with an optional one-line title. |
| `{jira:KEY …}` | A keyed Jira macro without a JQL query. |
| `<!-- toc … -->` | A table-of-contents macro and its encoded parameters. |
| `attachment:name` | A link or image targeting an attachment on the current page. |

Code-block metadata, image options, Jira-macro parameters, and TOC parameters use one quoted `key=value` grammar. The decoder rejects malformed keys, unterminated quotes, and adjacent unseparated values rather than guessing.

Normalization parses storage to a canonical tree, removes editor-only ignored elements and attributes, applies element-specific whitespace modes, sorts attributes and macro parameters, and emits one canonical XML spelling. The fidelity comparison uses positional XPath-like paths and distinguishes missing, extra, and changed nodes or attributes.

Read warnings classify unknown inline nodes, attributes, table shapes, unknown blocks, and unresolved users. `fenceReason()` turns preservation warnings into stable statistics buckets without exposing private traversal helpers.

Write warnings cover dropped code metadata, image titles, or TOC parameters, consumed references, and flattened link labels. Library callers receive structured records; CLI callers see the message and source line when available.

### CLI Commands

| Command surface | Purpose |
|-----------|---------|
| `confluence page get … --format md` | Reads storage with user resolution, warnings, and canonical Markdown output. |
| `confluence page get … --format view` | Converts rendered HTML for read-only inspection. |
| `confluence page create` / `comment add` | Converts authored Markdown using default writer forms after validation. |
| `confluence page update --file …` | Reuses cached users and inferred forms, then applies the fidelity gate. |
| `confluence page validate` | Sends generated storage only to Confluence's storage-to-view parser. |
| `confluence stats macros` | Aggregates macros, raw-fence reasons, and observed page shapes. |

## Integration Points

- **Depends on**: the shared mdast representation, XML fragment parsing, GFM extensions, and Confluence user lookup from [Confluence Domain](../concepts/confluence-domain.md).
- **Used by**: [Confluence Page Workflows](./confluence-page-workflows.md), comment rendering, page statistics, and working-file export/update.
- **External systems**: Confluence's user API resolves mentions; its content-body conversion endpoint validates generated storage but does not define local fidelity.

## Extension Guide

Add a construct only when both directions have a stable mdast or Markdown representation. Extend the reader, writer, extension parser/stringifier, normalization rules when needed, warning behavior, and fixtures together. If any source spelling carries information the representation cannot hold, keep raw fencing as the fallback.

When adding an ambiguous storage spelling, record it in `PageShapes`, give `StorageWriterOptions` a deterministic default, and infer the existing page's preference. Add fidelity fixtures covering pretty-printed and editor-normalized equivalents as well as a true semantic difference.

Keep view handling one-way and keep XML helper details internal. Public callers should use the converter, warning, normalization, and fidelity APIs rather than depending on traversal helpers or emitted tag ordering.

Test a new shape with storage input, expected Markdown, optional normalized storage, and warnings. Use the fixture notes to explain intentional normalization or preservation boundaries, not to create behavior absent from the converter.

Add fixtures using the layout and isolation rules in [Tests and Fixtures](../conventions/tests-and-fixtures.md).
