---
title: lassi Documentation
type: index
---

# lassi Documentation

Generated navigation for this corpus. Saaga rewrites this file from the
INDEX files on every documentation run — edit the documents it links to, not
this page.

Read in order: the architecture, then the core concepts, then the workflows.

## Architecture

- [Architecture](./ARCHITECTURE.md)

## Core Concepts

The concepts the rest of the corpus links to most often. Everything else assumes them.

- [Runtime Context](./concepts/runtime-context.md) — Effective configuration, credentials, injected host services, and filesystem access for each command.
- [Markdown Document](./concepts/markdown-document.md) — Canonical mdast and Markdown representation, frontmatter, mentions, and loss-preserving dialect fences.
- [Working File](./concepts/working-file.md) — Editable fields, reserved metadata, cache identity, and local or server drift state.
- [Search Index](./concepts/search-index.md) — Local semantic-search corpus, chunks, vectors, provenance, compatibility, and query hits.

## Workflows and Features

What the system does, end to end, in index order.

- [Command Execution](./features/command-execution.md) — End-to-end command dispatch, output selection, write safety, and error rendering.
- [Working File Lifecycle](./features/working-file-lifecycle.md) — Export, edit, diff, validate, write, and refresh path-specific working snapshots safely.
- [Jira Issue Workflows](./features/jira-issue-workflows.md) — Read, export, create, and safely update Jira issues and related activity.
- [Jira Wiki Conversion](./features/jira-wiki-conversion.md) — Bidirectional Jira wiki and Markdown conversion with explicit fidelity warnings.
- [Confluence Page Workflows](./features/confluence-page-workflows.md) — Find, export, create, validate, and safely update pages and related content.
- [Confluence Storage Conversion](./features/confluence-storage-conversion.md) — Loss-aware storage/view HTML and Markdown conversion with inferred writer forms and fidelity checks.
- [Search Indexing](./features/search-indexing.md) — Discover, chunk, incrementally embed, and durably publish exported Markdown.
- [Search Querying](./features/search-querying.md) — Validate, rank, filter, and render semantic matches with source evidence.
- [Skill Installation](./features/skill-installation.md) — Safely install and refresh Jira and Confluence agent skill assets.

## Indexes

- [Concept Index](./concepts/INDEX.md)
- [Pattern Index](./patterns/INDEX.md)
- [Convention Index](./conventions/INDEX.md)
- [Feature Index](./features/INDEX.md)
- [Glossary](./GLOSSARY.md) — every indexed term, with the definition its index gives it
