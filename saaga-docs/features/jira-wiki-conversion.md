---
title: "Feature: Jira Wiki Conversion"
type: feature
sources:
  - packages/jira/package.json
  - packages/jira/src/index.ts
  - packages/jira/src/wiki/**/*.ts
  - packages/core/src/markdown/*.ts
  - packages/cli/src/commands/jira/{body,issue-write,comment,transition}.ts
  - fixtures/jira/**
---

# Feature: Jira Wiki Conversion

## Overview

Jira wiki conversion translates Jira's stored wiki markup to canonical Markdown for editing and converts authored Markdown back to Jira syntax. Callers receive explicit warnings when Jira cannot preserve a Markdown shape faithfully.

## Key Concepts

Before working with this feature, understand these concepts:

- [Markdown Document](../concepts/markdown-document.md)
- The preservation contract is defined by [Loss-Aware Conversion](../patterns/loss-aware-conversion.md).

## Functional Specification

### Mechanism

1. `wikiToMarkdown()` tokenizes Jira wiki blocks and parses inline syntax into mdast.
2. Known constructs become shared GFM nodes or product nodes for mentions and colored text.
3. Unsupported bounded source is retained in a Jira-labelled raw fence instead of being discarded.
4. The shared Markdown writer serializes the tree into stable editable text.
5. For a write, `markdownToWiki()` parses canonical Markdown into mdast.
6. The serializer renders block and inline nodes with context-aware Jira escaping.
7. Supported but lossy Markdown shapes produce structured `WikiWarning` records; unsupported nodes fail validation.
8. `createWikiConverter()` exposes the same behavior through the shared `BodyConverter` interface.

### Validation Rules

- Jira raw fences are intentional passthrough regions; ordinary authored Jira syntax outside them is rejected by the shared leak check used by callers.
- Table rows must be structurally complete before becoming a GFM table; otherwise source is preserved rather than guessed.
- Wiki color values accept alphabetic names or three/six-digit hexadecimal values.
- Serializer escaping depends on container context so structural characters cannot accidentally open lists, tables, emphasis, links, images, or macros.
- Mentions preserve their Jira user key; resolving a Markdown mention to a user is caller policy, not parser policy.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Unknown block macro | The source survives in a `jira` raw fence. |
| Unknown inline macro | It remains literal or is preserved according to the bounded parse context. |
| Unsupported Markdown node | Serialization throws a validation `LassiError`; warnings are reserved for supported but lossy conversions. |
| Nested block inside a list item cannot map cleanly | Output is flattened or fenced and a warning identifies the loss. |
| Hard break appears inside a table cell | Jira-compatible HTML break output is used. |
| Adjacent emphasis runs meet at unsafe boundaries | Escaping and delimiter handling prevent accidental merging. |
| Bare URL has trailing punctuation | URL trimming keeps punctuation outside the link target. |
| Raw Jira fence is written back | Its content is restored as Jira source rather than rendered as code. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| mdast `Root` | `children` | Canonical intermediate tree shared with core Markdown. |
| `WikiSerializeResult` | `wiki`, `warnings` | Returns generated Jira source with fidelity diagnostics. |
| `WikiWarning` | `code`, `message`, optional `line` | Identifies a specific conversion compromise. |

### Services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-jira` | `wikiToMarkdown()` | Converts Jira wiki source to canonical Markdown. |
| `@wonna/lassi-jira` | `wikiToMdast()` | Parses Jira source into the shared syntax tree. |
| `@wonna/lassi-jira` | `markdownToWiki()` | Converts Markdown and returns warnings. |
| `@wonna/lassi-jira` | `mdastToWiki()` | Serializes an existing mdast tree to Jira. |
| `@wonna/lassi-jira` | `createWikiConverter()` | Creates the shared body-converter adapter. |

The parser recognizes headings, horizontal rules, block quotes, nested ordered and bullet lists, task markers, tables, code/noformat blocks, links, images, mentions, colors, inline code, and Jira emphasis. Parsing works on source lines first, then delegates phrasing content so block markers inside code and verbatim regions remain data.

The serializer walks mdast rather than applying text substitutions. Block rendering controls list prefixes, continuation lines, table delimiters, and blank-line separation; inline rendering tracks its container and neighboring nodes to decide when Jira punctuation must be escaped.

Warnings are values, not log side effects. This lets issue commands show them, automation inspect them, and a future caller choose stricter policy without changing conversion internals.

Warning codes distinguish supported compromises such as flattened structure and representations Jira cannot express exactly. Each warning is accumulated during traversal so one conversion can report every affected region.

Fixture directories pair wiki source, canonical Markdown, optional normalized wiki, read-back Markdown, warnings, and notes. They define semantic fixed points across parsing and serialization rather than promising identical punctuation for every supported construct.

Fixture notes record intentional normalization or loss so a changed expectation must be reviewed as a conversion decision, not accepted as an opaque snapshot update.
Property tests additionally exercise serializer stability across generated trees.

## Integration Points

- **Depends on**: core Markdown parsing/stringification, mdast/GFM node shapes, mention nodes, color nodes, raw fences, and dialect-leak detection.
- **Used by**: Jira issue descriptions, comments, transition comments, templates, exports, and working-file write-back.
- **External systems**: Jira's wiki-rendering contract; conversion itself performs no network or filesystem I/O.

## Extension Guide

Add a construct as a matched parser/serializer pair. Define its boundary rules in block tokenization or inline parsing, map it to an existing canonical node where semantics agree, and preserve it in a Jira raw fence otherwise. Add fixture coverage for source-to-Markdown, Markdown-to-source, normalized read-back, and warnings. Verify canonical Markdown reaches a fixed point and that literal punctuation near the new syntax remains escaped correctly.
