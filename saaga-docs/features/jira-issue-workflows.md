---
title: "Feature: Jira Issue Workflows"
type: feature
last_verified: 2026-09-30
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

Jira workflows let a user inspect, export, create, and safely update issues, project components, fix versions, and related comments, attachments, links, transitions, and activity digests. Commands share Jira identity and field rules while keeping remote writes behind Lassi's read-only and dry-run controls.

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
5. Use the sibling commands for comments, attachments, transitions, bulk export, or a personal activity digest. To remove a link, inspect `jira link list KEY1`, then run `jira link delete KEY1 KEY2 --type PHRASE` with the relationship as displayed from KEY1.
6. To assign project components, inspect `jira component list PROJECT`, then run `jira issue component add KEY NAME...` or `jira issue component remove KEY NAME...`. Add `--create` to make missing project components before assigning them; `jira component create PROJECT NAME --description TEXT` creates one independently.
7. To choose fix versions, inspect `jira version list PROJECT`, then run `jira issue fix-version set KEY VERSION...`. This replaces the issue's fix versions; `--add` retains its current ones.

### Validation Rules

- Direct issue keys must match the Jira key shape. Branch lookup selects the first capture from a configured pattern; without one, it selects the first default-project match, then the first issue-shaped match anywhere. It accepts a selected key only if its shape is valid and does not reject branches with multiple keys.
- `jira component list/create` and `jira version list` trim, uppercase, and validate their project argument as a project key, and reject `.`, which stands only for an issue key. `jira issue create --project` and `jira issue createmeta PROJECT` pass the project through unchanged.
- `jira issue get KEY --comments` and `--comments all` include all comments. A numeric value must be a positive whole number and selects the newest N; invalid values fail even alongside `--all`.
- `--field` uses `alias=value`; configured aliases, standard fields, and raw custom-field IDs are accepted.
- Create requires project, issue type, and summary after template and flag merging. The live create-metadata check rejects other required fields only when unset and without a server default; it exempts auto-filled `project`, `issuetype`, and `reporter`.
- Body sources are mutually exclusive where commands accept both inline Markdown and a file or stdin.
- If a working file contains a top-level `key`, it must match the command key. The reserved `readonly` mapping is informational and is excluded from update fields.
- Update checks a changed value against allowed values only for the field types listed in [Jira Domain](../concepts/jira-domain.md). Clears and JSON values are never checked.
- File-based updates require a cached entry for that exact path and an unchanged generated tail. The cache does not authenticate the current file with a hash. `--if-unchanged` additionally compares the live server marker with the cached marker.
- Transition names or IDs must select exactly one available transition; transition screen fields use that transition's metadata.
- Comment deletion is limited to the current user's comments unless `--any` is supplied.
- Link create and delete require two distinct issue keys and `--type`; deletion needs exactly one link matching the displayed relationship from the first issue.
- Component add accepts names already assigned to the issue unchanged and resolves the others against the project catalog; fix-version set resolves every name against the project's versions; component remove resolves names against components assigned to the issue. Each check precedes its respective write. Exact spelling wins over case-insensitive matching; ambiguous matches require exact spelling. See [Jira Domain](../concepts/jira-domain.md) for the resolution and request contracts.
- Component add rejects unknown names unless `--create` is set and rejects an archived project component when it is not already on the issue. Component remove requires every requested name to be on the issue; duplicate names resolve once.
- Fix-version set accepts only non-archived project versions, released or not. Unknown names fail as `not_found`, archived names as `validation`; duplicate versions resolve once.
- Numeric limits and attachment size values must be positive; issue search `--all` still stops at its hard cap.
- All remote mutations pass through the shared [Command Execution](./command-execution.md) write guard.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| `.` is passed outside a matching branch | The command fails with guidance to supply a key or configure the branch pattern. |
| Jira returns only part of the changelog or comments | Output records coverage and warns that older data is missing. |
| A filtered custom field is absent from this Jira instance | When field names are needed, the command warns that the alias or ID is not a field on the instance. It still returns normal output, including `no changes` when nothing matches. |
| Two fields have the same display name | When field names are needed, the command warns that ID-less changes with that name can match more than one field. It still returns normal output. |
| Search has more results than requested | The command reports shown versus total; `--all` paginates to the cap. |
| Working-file update changes no writable data | After any requested drift check, return `no changes` without fetching edit metadata, sending an update, or rewriting the file. |
| A changed value is outside the cached allowed values | Fail with a validation error before fetching edit metadata or sending the update; the hint names when the values were cached and `jira issue editmeta KEY` to refresh them. |
| Edit metadata must be fetched from Jira | A `warn:` line on stderr, hidden by `--quiet`, names the fields that need it, because Jira can take minutes to answer on large projects. |
| A link type phrase names no type or several types | The command rejects it and points to `jira link types` or the exact direction phrase. |
| Link deletion finds no matching relationship | It reports `not_found`; if the issues have another relationship, the hint prints its wording for `--type`. |
| Link deletion finds multiple matching links | It reports `validation` with the matching IDs and deletes none. Equal inward and outward wording matches either stored direction. |
| Description conversion emits warnings | Warnings are surfaced before the guarded write rather than silently discarded. |
| Attachment exceeds the configured or command limit | Download skips it and reports the skip; accepted files retain collision-safe names. |
| Batch export encounters existing or failed files | Per-issue results are retained and the batch error follows successful output. |
| Digest JQL fragment contains unsafe clauses | It is rejected before combining with the built-in section queries. |
| Adding components already on the issue | Return `no changes`, naming them, when all names are already assigned. Otherwise add the rest: the Markdown line names only the additions, while JSON and AXI list the already-assigned names under `unchanged`. |
| Fix-version set receives the current set, or `--add` receives only current versions | Return `no changes` without an issue update. Names resolve before this comparison, so if one of those versions is archived the command fails with `validation` instead. |
| Replacing fix versions would drop an archived version already on the issue | Warn that it cannot be assigned again; `--add` retains it. |
| Component creation succeeds but a later create or issue update fails | Return the created components as partial success, then surface the error. Re-running can assign the now-existing components. |
| A project lookup fails or component creation is forbidden | A missing project gets a project-key hint; a create 403 points to the Administer Projects permission. |

## Technical Implementation

### Data Model

The Jira issue and field metadata models used by these commands are described in [Jira Domain](../concepts/jira-domain.md).

### Services/Functions

The public Jira client and field conversion services used by these commands are listed in [Jira Domain](../concepts/jira-domain.md).

### CLI Commands

| Command | Purpose |
|-----------|---------|
| `jira issue get/search/export` | Read one issue, query Jira, or save issue working files in bulk. |
| `jira component list PROJECT` / `jira component create PROJECT NAME [--description TEXT]` | List project components or create a named component with an optional description. |
| `jira version list PROJECT` | List non-archived versions available as fix versions, including released versions. |
| `jira issue component add KEY NAME... [--create]` / `jira issue component remove KEY NAME...` | Assign existing or newly created components, or remove assignments while leaving project components intact. |
| `jira issue fix-version set KEY VERSION... [--add]` | Replace fix versions, or add to the issue's current set. |
| `jira issue create/update` | Create from flags/templates or update fields, body, or a working file. |
| `jira issue createmeta/editmeta/changelog` | Inspect valid fields and ordered field history; `editmeta` also refreshes the cache that update reads. `jira issue changelog KEY --fields` filters returned history by alias, name, or ID, including ID-less custom-field changes through aliases and IDs when Jira supplies their names. See [Jira Domain](../concepts/jira-domain.md) for field identity rules. |
| `jira comment list/add/edit/delete` | Read and mutate issue comments. |
| `jira attachment get/upload` | Download bounded attachments or upload local files. |
| `jira transition list/do` | Inspect and execute available transitions with screen fields. |
| `jira link types/list/create/delete` | Inspect link semantics, create a directed issue link, or remove one displayed relationship. |
| `jira fields` and `jira templates` | Inspect configured aliases and reusable creation templates. |
| `jira digest` | Summarize assigned, mentioned, and recently changed work. |

Command registration starts at `registerJira()`, which attaches every group to the `jira` command invoked by `createProgram()`. Reads and writes use the same context, output formats, structured errors, and injected services.

Create merges template defaults before explicit flags, resolves live metadata, maps aliases, validates required fields, converts the Markdown description to Jira wiki markup, then calls the client. Update follows the same coercion rules, but loads edit metadata only when a changed field needs it; a transition uses its screen's metadata instead.

Issue retrieval requests expansion fields only when needed. A bare `--comments` or `--comments all` includes all comments; a positive integer selects the newest count. Attachments and links become generated read-only sections. `--out` writes the selected Markdown path and a per-path baseline under `.lassi/cache/jira/`, which later updates use to compute field and body changes.

Changelog reads the issue history first. If `--fields` includes a custom-field alias or raw ID and any returned history item lacks `fieldId`, it then calls `JiraClient.fields()` (`GET /rest/api/2/field`) to supply the instance names before filtering. Filters that do not resolve to a custom-field ID, and histories where every item has `fieldId`, need no field-list request. The fetched names may produce the warnings in Edge Cases; warnings use the shared [Command Execution](./command-execution.md) rendering path and do not suppress the result.

The command families use these product-specific paths:

| Operation | Read and preparation | Guarded effect |
|-----------|----------------------|----------------|
| Issue create | Merge template and flags; fetch create metadata; validate and coerce fields. | POST the issue fields and converted description. |
| Issue update | Collect file and flag changes; optionally compare the live marker; load edit metadata only when a final changed value needs it. | Convert the selected values, then guard and PUT only changed fields and description. |
| Comment add/edit | Read Markdown from one selected source and convert it. | Create or replace the wiki body. |
| Comment delete | Fetch current user and comment authorship unless `--any`. | Delete the selected comment. |
| Attachment upload | Resolve and read every local path for the multipart request. | Upload accepted files to the issue. |
| Transition | Resolve the available transition and coerce its screen fields. | Apply transition fields and optional comment. |
| Link create | Resolve type wording to the sentence printed for the first and second issue; build the request described in [Jira Domain](../concepts/jira-domain.md). | POST the link in that sentence's direction. |
| Link delete | Resolve the displayed phrase, list links from the first issue, and require one match by type, other key, and direction. | Preview the concrete DELETE path, then delete by validated numeric link ID. |
| Project component create | Validate project and name; check for a matching existing component. | Preview and POST the project component, with optional description. |
| Issue component add | Fetch issue project and current components; accept already-assigned names unchanged, then resolve new assignments against the project catalog before writing. | With `--create`, guard and POST each missing project component first; then guard and PUT additive issue operations. |
| Issue component remove | Fetch current issue components and require every requested name to match. | Guard and PUT removal operations; project components remain available. |
| Issue fix-version set | Fetch issue project and current fix versions; resolve every requested name from project versions. | Guard and PUT a replacement list, or additive operations with `--add`. |

Each component create and the final issue update has its own `guardWrite()` call. A dry run with `--create` collects previews for every planned POST and the final PUT; names stand in for IDs that do not exist yet. An actual run uses the returned IDs. If an earlier create succeeded before a later Jira error, the command returns that partial result and the shared error path prints it before a nonzero exit. The common preview and output rules are in [Command Execution](./command-execution.md).

Project component listing includes archived entries and marks them in output. Version listing filters archived entries before rendering Markdown, JSON, or AXI. The project catalogs, types, and request semantics are defined in [Jira Domain](../concepts/jira-domain.md).

Edit metadata is slow on large projects because Jira computes allowed values for every field on the edit screen. Update first collects changed file fields and `--field` values by resolved field ID, keeping the last value for each ID. It then decides which final values need metadata. Only when one does, it probes the issue for project and issue type, or reuses the issue fetched for `--if-unchanged`. It uses a fresh cache entry when available, otherwise fetches live metadata. Next it converts the selected values, reports cached allowed-value failures with a refresh hint, builds the payload, and passes it through the write guard before sending. `jira issue editmeta` always requests live metadata and stores a non-empty answer for later updates. Cache identity, validity, and the request deadline are in [Jira Domain](../concepts/jira-domain.md).

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
