---
title: Markdown Document
type: concept
sources:
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/core/src/markdown/*.ts
last_verified: 2026-09-19
---

# Markdown Document

## Business Definition

A Markdown document is Lassi's canonical, product-neutral representation of editable Atlassian content. Jira wiki markup and Confluence storage XHTML cross a dialect boundary into GitHub-Flavored Markdown and mdast so agents edit one predictable format.

## Configuration

| Source | Description |
|--------|-------------|
| `STRINGIFY_OPTIONS` | Pins list markers, emphasis, fences, rules, definitions, and other canonical Markdown choices. |
| `ParseMarkdownOptions` | Adds product syntax to the shared GFM and mention parser. |
| `StringifyMarkdownOptions` | Adds product node handlers and unsafe-character rules to the shared writer. |
| `RAW_FENCE_LANGS` | Maps `wiki` to fenced language `jira` and `storage` to `confluence`. |

**How to access:**

- `parseMarkdown()` - parses GFM, mentions, and optional product extensions into an mdast `Root`.
- `stringifyMarkdown()` - serializes mdast using the canonical formatting rules.
- `normalizeMarkdown()` - returns the canonical `stringify(parse(markdown))` form.
- `STRINGIFY_OPTIONS` (constant) - contains the shared serialization choices.
- `RAW_FENCE_LANGS` (constant) - contains the two supported passthrough fence names.

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| mdast `Root` | `children` | Holds the canonical block and phrasing node tree used by converters. |
| `Mention` | `username` | Stores an `@name` independently of either Atlassian representation. |
| `Mention` | `userKey` | Retains an unresolved Confluence user key when reading storage XHTML. |
| `Code` | `lang`, `value` | Carries unsupported source markup in a `jira` or `confluence` raw fence. |
| `SplitResult` | `data`, `body` | Separates an optional leading YAML mapping from the Markdown body. |

The shared parser recognizes GFM plus `@mention`. A mention cannot begin after a word character, `@`, `.`, `/`, or `-`, which keeps email addresses and paths as text. Names accept letters, digits, underscores, and internal dots or dashes; trailing punctuation remains outside. The writer escapes literal text that would otherwise become a mention on the next parse.

Bare URL, `www.` URL, and email literals become link nodes. The writer keeps safe literals bare and uses an explicit link when following content could be swallowed into the URL. Adjacent runs of the same emphasis node are merged because Markdown has no stable spelling that preserves their boundary.

Frontmatter must start at the beginning of the file with `---`, end with another `---`, and parse as a YAML mapping under the YAML 1.2 core schema. That schema leaves timestamps as strings for stable comparisons. Serialization supports selected flow-style maps and field comments, removes trailing body whitespace, and writes a final newline.

A raw fence is an ordinary fenced code node whose language identifies its source dialect. Product converters use `jira` and `confluence` fences to retain source constructs that mdast cannot represent. Exact product syntax belongs to the later conversion features.

The dialect boundary is deliberately small:

| Value | Meaning |
|-------|---------|
| `wiki` | Jira wiki source represented by a `jira` fence when passed through. |
| `storage` | Confluence storage XHTML represented by a `confluence` fence when passed through. |

`BodyConverter` is the shared adapter contract. Its `format` identifies the dialect, `toMarkdown()` reads raw product content, and `fromMarkdown()` produces content suitable for that product. This keeps CLI callers independent of a converter's parser and writer implementation and leaves room for another dialect without changing their call shape.

Leak detection protects that boundary for agent-authored input. It recognizes characteristic Jira headings, macros, links, mentions, tables, and monospace syntax, plus Confluence `ac:` and `ri:` elements. Any detected dialect is a leak regardless of the target product: authored body text must be GFM unless the source is intentionally isolated in a matching raw fence.

| Input location | Leak scan behavior |
|----------------|--------------------|
| paragraph, heading, table cell | Scans reconstructed plain text for source signatures. |
| inline code | Skipped because the content is presented literally. |
| fenced code or raw fence | Skipped because the content is intentionally isolated. |
| HTML node | Scanned directly for Confluence storage signatures. |

The generated-section helpers establish a second boundary inside a working-file body:

| Function | Contract |
|----------|----------|
| `joinSections()` | Drops empty sections, trims their ends, and records one blank line between them. |
| `composeBody()` | Places the editable description before non-empty generated sections and ends with a newline. |
| `stripGeneratedSections()` | Returns `undefined` if the recorded tail is absent or differs. |
| `expansionFromSections()` | Recovers comments, attachments, and links flags from exact level-two headings. |

These helpers do not decide what a comment, attachment, or link means. They only maintain the shared separation between source content and generated display material.

See [Working File](./working-file.md) for how the generated tail is stored in the cache.

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-core` | `parseMarkdown()` | Builds the shared mdast representation. |
| `@wonna/lassi-core` | `stringifyMarkdown()` | Writes canonical Markdown from mdast. |
| `@wonna/lassi-core` | `normalizeMarkdown()` | Canonicalizes a Markdown string. |
| `@wonna/lassi-core` | `splitFrontmatter()` | Reads a leading YAML mapping without coercing timestamps to dates. |
| `@wonna/lassi-core` | `joinFrontmatter()` | Renders YAML metadata and a normalized body. |
| `@wonna/lassi-core` | `rawFence()` | Creates a dialect-labelled passthrough node. |
| `@wonna/lassi-core` | `isRawFence()` | Recognizes either or one requested dialect fence. |
| `@wonna/lassi-core` | `detectDialectLeak()` | Finds unfenced Jira wiki or Confluence storage signatures in authored prose. |
| `@wonna/lassi-core` | `autolinkLiterals()` | Applies the shared GFM literal-link transform to converter-built trees. |
| `@wonna/lassi-core` | `composeBody()` | Joins an editable description and generated sections. |
| `@wonna/lassi-core` | `stripGeneratedSections()` | Rejects an edited generated tail or returns the editable description. |

Import these functions from `@wonna/lassi-core`; see [TypeScript Modules](../conventions/typescript-modules.md) for package boundaries.

## Internal Implementation

- `stringifyMarkdown()` copies the tree while merging adjacent emphasis runs, so normalization does not mutate a converter's input.
- The leak detector ignores code, inline code, and raw fences. It scans whole paragraphs, headings, and table cells because source syntax can span multiple mdast nodes.
- Frontmatter errors use the shared structured error contract, making an unclosed block, invalid YAML, or a non-mapping a usage failure.

## Reference Implementations

- `packages/core/src/markdown/parse.ts` - the shared parser and product-extension seam.
- `packages/core/src/markdown/stringify.ts` - canonical formatting and fixed-point safeguards.
- `packages/core/src/markdown/frontmatter.ts` - YAML mapping split and join behavior.
- `packages/core/src/markdown/mention.ts` - a custom node with matching parse and write extensions.
- `packages/core/src/markdown/raw-fence.ts` - the loss-preserving dialect boundary.
- `normalizeMarkdown()` - the public canonicalization entry point.
- `detectDialectLeak()` - the public authored-input safeguard.

## Related Concepts

- [Working File](./working-file.md)
- The reusable conversion flow is documented in [Loss-Aware Conversion](../patterns/loss-aware-conversion.md).
- Failures from parsing and leak detection use the [Error Contract](./error-contract.md).
