---
title: "Feature: Jira Issue Workflows"
type: feature
sources:
  - packages/jira/package.json
  - packages/cli/src/commands/shared/{storage,export-manifest}.ts
  - packages/cli/src/cli.ts
  - packages/cli/src/commands/jira/*.ts
  - packages/cli/src/guard-write.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/context.ts
  - packages/cli/src/output/*.ts
  - packages/cli/src/workfile/*.ts
  - packages/jira/src/index.ts
  - packages/jira/src/{client,fields,issue,changelog,digest}/**/*.ts
---

# Feature: Jira Issue Workflows

## Overview

Jira workflows let a user inspect, export, create, and safely update issues and their related comments, attachments, links, transitions, and activity digests. Commands share Jira identity and field rules while keeping remote writes behind Lassi's read-only and dry-run controls.

## Key Concepts

Before working with this feature, understand these concepts:

- [Jira Domain](../concepts/jira-domain.md)
- [Working File](../concepts/working-file.md)
- Descriptions and comments cross the [Jira Wiki Conversion](./jira-wiki-conversion.md) boundary.

## Functional Specification

### User Flow

1. Configure Jira access, aliases, and any default project or templates through the [Runtime Context](../concepts/runtime-context.md).
2. Identify an issue by key, or pass `.` to derive a key from the current branch.
3. Inspect the issue, search with JQL, or query create/edit metadata before authoring fields.
4. For local editing, run `jira issue get KEY --out file.md`, edit writable frontmatter and Markdown, then run `jira issue update KEY --file file.md --if-unchanged`. The flag enables a server-drift check; omitting it skips that check. See [Working File Lifecycle](./working-file-lifecycle.md) for caching and refresh behavior.
5. Use the sibling commands for comments, attachments, transitions, links, bulk export, or a personal activity digest.

### Validation Rules

- Direct issue keys must match the Jira key shape; branch-derived lookup must find exactly one usable key.
- `--field` uses `alias=value`; configured aliases, standard fields, and raw custom-field IDs are accepted.
- Create requires project, issue type, and summary after template and flag merging, plus every field marked required by live create metadata.
- Body sources are mutually exclusive where commands accept both inline Markdown and a file or stdin.
- If a working file contains a top-level `key`, it must match the command key. The reserved `readonly` mapping is informational and is excluded from update fields.
- Update checks a changed value against allowed values only for the field types listed in [Jira Domain](../concepts/jira-domain.md). Clears and JSON values are never checked.
- File-based updates require a cached entry for that exact path and an unchanged generated tail. The cache does not authenticate the current file with a hash. `--if-unchanged` additionally compares the live server marker with the cached marker.
- Transition names or IDs must select exactly one available transition; transition screen fields use that transition's metadata.
- Comment deletion is limited to the current user's comments unless `--any` is supplied.
- Numeric limits and attachment size values must be positive; issue search `--all` still stops at its hard cap.
- All remote mutations pass through the shared [Command Execution](./command-execution.md) write guard.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| `.` is passed outside a matching branch | The command fails with guidance to supply a key or configure the branch pattern. |
| Jira returns only part of the changelog or comments | Output records coverage and warns that older data is missing. |
| Search has more results than requested | The command reports shown versus total; `--all` paginates to the cap. |
| Working-file update changes no writable data | After any requested drift check, return `no changes` without fetching edit metadata, sending an update, or rewriting the file. |
| A changed value is outside the cached allowed values | Fail with a validation error before fetching edit metadata or sending the update; the hint names when the values were cached and `jira issue editmeta KEY` to refresh them. |
| Edit metadata must be fetched from Jira | A `warn:` line on stderr, hidden by `--quiet`, names the fields that need it, because Jira can take minutes to answer on large projects. |
| Description conversion emits warnings | Warnings are surfaced before the guarded write rather than silently discarded. |
| Attachment exceeds the configured or command limit | Download skips it and reports the skip; accepted files retain collision-safe names. |
| Batch export encounters existing or failed files | Per-issue results are retained and the batch error follows successful output. |
| Digest JQL fragment contains unsafe clauses | It is rejected before combining with the built-in section queries. |

## Technical Implementation

The client API and data models are described in [Jira Domain](../concepts/jira-domain.md).

### CLI Commands

| Command | Purpose |
|-----------|---------|
| `jira issue get/search/export` | Read one issue, query Jira, or save issue working files in bulk. |
| `jira issue create/update` | Create from flags/templates or update fields, body, or a working file. |
| `jira issue createmeta/editmeta/changelog` | Inspect valid fields and ordered field history; `editmeta` also refreshes the cache that update reads. |
| `jira comment list/add/edit/delete` | Read and mutate issue comments. |
| `jira attachment get/upload` | Download bounded attachments or upload local files. |
| `jira transition list/do` | Inspect and execute available transitions with screen fields. |
| `jira link types/list/create` | Inspect link semantics and create a directed issue link. |
| `jira fields` and `jira templates` | Inspect configured aliases and reusable creation templates. |
| `jira digest` | Summarize assigned, mentioned, and recently changed work. |

Command registration starts at `registerJira()`, which attaches every group to the `jira` command invoked by `createProgram()`. Reads and writes use the same context, output formats, structured errors, and injected services.

Create merges template defaults before explicit flags, resolves live metadata, maps aliases, validates required fields, converts the Markdown description to Jira wiki markup, then calls the client. Update follows the same coercion rules, but loads edit metadata only when a changed field needs it; a transition uses its screen's metadata instead.

Issue retrieval requests expansion fields only when needed. Comments can mean all or the newest count; attachments and links become generated read-only sections. `--out` writes the selected Markdown path and a per-path baseline under `.lassi/cache/jira/`, which later updates use to compute field and body changes.

The command families use these product-specific paths:

| Operation | Read and preparation | Guarded effect |
|-----------|----------------------|----------------|
| Issue create | Merge template and flags; fetch create metadata; validate and coerce fields. | POST the issue fields and converted description. |
| Issue update | Diff flags or cached file; compare the live marker only with `--if-unchanged`; load edit metadata only for changed fields that need it, from the local cache when fresh. | PUT only changed fields and description. |
| Comment add/edit | Read Markdown from one selected source and convert it. | Create or replace the wiki body. |
| Comment delete | Fetch current user and comment authorship unless `--any`. | Delete the selected comment. |
| Attachment upload | Resolve and read every local path for the multipart request. | Upload accepted files to the issue. |
| Transition | Resolve the available transition and coerce its screen fields. | Apply transition fields and optional comment. |
| Link create | Resolve type wording and inward/outward issue placement. | Create the directed link. |

Edit metadata is slow on large projects because Jira computes allowed values for every field on the edit screen. Update collects the changed fields first, keeping the last value given for each field, and loads metadata only when one of them needs it. A cheap issue fetch finds the project and issue type that name the cache entry, reusing the `--if-unchanged` request when there is one. A fresh entry answers without asking Jira; otherwise update fetches live metadata and stores a non-empty answer. `jira issue editmeta` always asks Jira and stores a non-empty answer the same way. The cache contract and the request deadline are in [Jira Domain](../concepts/jira-domain.md).

Issue export searches JQL page by page and writes one workfile/cache pair per issue under the archive lock. It includes attachment and link sections, with comments optional. The manifest records hashes, renderer settings, and query coverage. Failures remain attributable to individual keys; the lifecycle document describes conflict protection.

Attachment download derives a stable local name from attachment ID and filename, filters by optional glob, enforces the effective byte limit, and writes into the selected directory. Existing names remain distinguishable because the server ID participates in the local filename.

Reference commands deliberately expose Jira metadata rather than duplicating it in static help. `jira fields` relates configured aliases to server definitions, `jira link types` shows both directional labels, and create/edit metadata report required flags, schemas, and allowed values at the point of use.

Digest builds bounded queries for issues assigned to the current user, direct comment mentions, and recently updated work. It fetches issues and comments through the same Jira client and builds deterministic actions and snippets. An optional JQL clause narrows every section, while the per-section limit prevents one category from consuming the whole report. Comment snippets and changed values are bounded for readable output; JSON retains the structured records.

All commands can render Markdown for people and structured data for automation. File-producing commands return paths and counts in structured output, while warnings travel through the shared logger or result trailer instead of contaminating the primary data object.

Dry-run is evaluated after parsing, metadata lookup, validation, and payload construction. This makes the preview representative of the request that would be sent while preserving the shared guarantee that no remote mutation occurs.

The client remains the only remote boundary. Command modules decide user intent and presentation; Jira package helpers own API shapes, field conversion, identity, direction, and history semantics.

Follow [Tests and Fixtures](../conventions/tests-and-fixtures.md). Workflow tests should assert outgoing method, path, and payload, including Jira-version fallbacks and pagination boundaries. Check Markdown, JSON, and AXI results where those forms differ.

## Integration Points

- **Depends on**: [Jira Domain](../concepts/jira-domain.md), [Jira Wiki Conversion](./jira-wiki-conversion.md), runtime context, working-file storage, and command execution.
- **Used by**: interactive CLI use, automation through JSON or AXI output, and exported Markdown workspaces.
- **External systems**: a configured Jira Server or Data Center HTTP API and the local filesystem supplied through CLI dependencies.

## Extension Guide

Add a remote operation to the public `JiraClient` and package barrel first, using the injected HTTP client. Register a CLI command beneath `registerJira()`, classify it as read or write, resolve keys and aliases through the shared helpers, and return all supported output forms. New writes must validate with Jira's field metadata where the value depends on it, call `guardWrite()` at the request boundary, and provide a dry-run preview. Slow metadata may come from a bounded local cache, as edit metadata does for update. Extend existing working-file sections only through the lifecycle's generated/read-only boundaries; do not create a second cache protocol.
