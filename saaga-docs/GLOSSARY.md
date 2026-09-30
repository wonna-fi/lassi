---
title: Glossary
type: index
---

# Glossary

Every term the INDEX files name, with the one-line definition its index gives
it. Saaga regenerates this file on every documentation run and copies each
definition verbatim — to change one, change the INDEX row it comes from.

- [Command Execution](./features/command-execution.md) — End-to-end command dispatch, output selection, write safety, and error rendering.
- [Confluence Domain](./concepts/confluence-domain.md) — Confluence page references, pages, comments, attachments, users, macro statistics, and client APIs.
- [Confluence Page Workflows](./features/confluence-page-workflows.md) — Find, export, create, validate, and safely update pages and related content.
- [Confluence Storage Conversion](./features/confluence-storage-conversion.md) — Loss-aware storage/view HTML and Markdown conversion with inferred writer forms and fidelity checks.
- [Error Contract](./concepts/error-contract.md) — Structured failure categories, envelopes, hints, redaction, and process exit codes.
- [Injected I/O and HTTP](./patterns/injected-io-and-http.md) — Build deterministic, safe filesystem and HTTP code from injected capabilities.
- [Jira Domain](./concepts/jira-domain.md) — Jira issue identity, project components and versions, fields, comments, links, transitions, history, and client APIs.
- [Jira Issue Workflows](./features/jira-issue-workflows.md) — Read, export, create, and safely update Jira issues, components, fix versions, and related activity.
- [Jira Wiki Conversion](./features/jira-wiki-conversion.md) — Bidirectional Jira wiki and Markdown conversion with explicit fidelity warnings.
- [Loss-Aware Conversion](./patterns/loss-aware-conversion.md) — Convert rich-text dialects through mdast with deterministic normalization, passthrough, and explicit warnings.
- [Markdown Document](./concepts/markdown-document.md) — Canonical mdast and Markdown representation, frontmatter, mentions, and loss-preserving dialect fences.
- [Runtime Context](./concepts/runtime-context.md) — Effective configuration, credentials, injected host services, and filesystem access for each command.
- [Search Index](./concepts/search-index.md) — Local semantic-search corpus, chunks, vectors, provenance, compatibility, and query hits.
- [Search Indexing](./features/search-indexing.md) — Discover, chunk, incrementally embed, and durably publish exported Markdown.
- [Search Querying](./features/search-querying.md) — Validate, rank, filter, and render semantic matches with source evidence.
- [Skill Installation](./features/skill-installation.md) — Safely install and refresh Jira and Confluence agent skill assets.
- [Tests and Fixtures](./conventions/tests-and-fixtures.md) — Colocation, isolation, and fixture-layout rules for automated tests.
- [TypeScript Modules](./conventions/typescript-modules.md) — ESM import, package export, and type-only import rules for TypeScript modules.
- [Working File](./concepts/working-file.md) — Editable fields, reserved metadata, cache identity, and local or server drift state.
- [Working File Lifecycle](./features/working-file-lifecycle.md) — Export, edit, diff, validate, write, and refresh path-specific working snapshots safely.
