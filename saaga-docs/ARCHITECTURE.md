---
title: Architecture
type: architecture
sources:
  - "package.json"
  - "packages/*/package.json"
  - "packages/*/src/**"
  - "packages/cli/bin/**"
  - "skills/**"
  - "scripts/**"
  - "fixtures/**"
last_verified: 2026-09-19
---

# Architecture

## Overall Architecture

Lassi is a Node.js 24, TypeScript ESM command-line application for coding agents that work with Jira and Confluence Data Center. It also builds a local semantic index over exported Markdown. The npm workspace separates reusable domain libraries from a single executable package.

The executable constructs a command program and supplies its environment through an explicit dependency object: filesystem access, HTTP transport, credentials, process streams, clocks, and other host services described in [Runtime Context](./concepts/runtime-context.md). Command adapters coordinate the domain packages, render human- or machine-oriented output, and apply shared safeguards around remote writes and local persisted data.

All internal dependencies point toward `core`. The `jira`, `confluence`, and `search` packages depend only on `core` and remain independent of one another; `cli` is the composition root and may depend on all four libraries. A boundary check enforces this direction in manifests and source imports.

Jira and Confluence data cross the application boundary through injected HTTP clients. Their native markup is converted through a shared [Markdown syntax-tree representation](./concepts/markdown-document.md) before being written to workfiles, exports, or the search corpus. Search sends chunks to a configured OpenAI-compatible or Azure-authenticated embedding service and keeps the resulting vector index on the local filesystem.

Configuration and credentials enter through explicit CLI dependencies and layered configuration. Filesystem abstractions, structured errors, redacted logging, write guards, dry runs, compatibility metadata, and shared storage locks form cross-cutting constraints at the core and CLI boundaries.

Tests are colocated with source and replace external services with fabricated fixtures, in-memory filesystems, or injected fetch implementations. Packaging produces the executable distribution together with build metadata and installable agent skills.

## Modules

### CLI application — `packages/cli`

The composition root exposes the `lassi` executable, binds host dependencies, coordinates domain packages through [command execution](./features/command-execution.md), and owns presentation, the [working-file lifecycle](./features/working-file-lifecycle.md), storage safety, and diagnostics. Its command groups cover Jira and Confluence operations, local search, diagnostics, configuration display, skill installation, and comprehensive help.

Dependencies: `core`, `jira`, `confluence`, and `search`, plus Commander, TOON formatting, and Azure Identity.

### Core foundation — `packages/core`

Provides the shared contracts for configuration, authentication, HTTP transport, filesystem access, errors, redacted logging, Markdown syntax trees, git metadata, text, and time. It is the inward dependency boundary for every other runtime package and exposes test doubles for isolated consumers.

Dependencies: external utility libraries only; no other Lassi package.

### Jira integration — `packages/jira`

Provides Jira Data Center access and domain transformations for the [Jira domain](./concepts/jira-domain.md), including the [issue workflows](./features/jira-issue-workflows.md) and Jira wiki markup. Callers supply shared transport and configuration concerns through `core` contracts.

Dependencies: `core` and Markdown syntax-tree utilities.

### Confluence integration — `packages/confluence`

Provides Confluence Data Center access and domain transformations for the [Confluence domain](./concepts/confluence-domain.md), including the [page workflows](./features/confluence-page-workflows.md) and conversions between Confluence storage or view formats and Markdown. Conversion boundaries preserve unsupported content and surface fidelity warnings to callers.

Dependencies: `core`, HTML/XML parsing utilities, and Markdown syntax-tree utilities.

### Search engine — `packages/search`

Provides local semantic search over Markdown using a durable [search index](./concepts/search-index.md): [indexing](./features/search-indexing.md) covers document chunking, embedding-service access, and compatible vector storage, while [querying](./features/search-querying.md) performs similarity searches. It does not know how Jira or Confluence content was acquired.

Dependencies: `core` and Markdown syntax-tree types.

### Agent skills — `skills`

Contains guidance assets for coding agents. The CLI's [skill installation](./features/skill-installation.md) installs the Jira and Confluence skills; Jira-review is bundled separately in the distribution. These are versioned distribution resources rather than executable runtime packages.

Dependencies: the CLI installer and the corresponding public CLI command surfaces.

### Engineering toolchain — `scripts` and `fixtures`

Owns package-boundary enforcement, build metadata and bundling, package assembly, release validation, read-only smoke checks, retrieval evaluation, and fabricated compatibility fixtures. It supports development and distribution but is not imported by runtime packages.

Dependencies: workspace configuration, runtime package sources, and colocated tests.
