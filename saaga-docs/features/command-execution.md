---
title: "Feature: Command Execution"
type: feature
last_verified: 2026-10-03
sources:
  - packages/cli/src/cli.ts
  - packages/cli/src/commands/{jira,confluence}/*.ts
  - packages/cli/src/commands/search/*.ts
  - packages/cli/src/commands/doctor/**/*.ts
  - packages/cli/src/commands/config-show.ts
  - packages/cli/src/commands/skills/*.ts
  - packages/cli/src/commands/help-all.ts
  - packages/cli/src/help/*.ts
  - packages/cli/src/context.ts
  - packages/cli/src/deps.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/guard-write.ts
  - packages/cli/src/run.ts
  - packages/cli/src/main.ts
  - packages/cli/src/output/*.ts
  - packages/core/src/errors/*.ts
  - packages/core/src/logging/*.ts
---

# Feature: Command Execution

## Overview

Command execution is the common dispatch and output machinery behind every Lassi CLI capability. It builds one safe runtime context, runs a registered handler, renders exactly the selected output format, and converts every failure into the shared stderr and exit-code contract.

## Key Concepts

Before working with this feature, understand these concepts:

- [Runtime Context](../concepts/runtime-context.md)
- [Error Contract](../concepts/error-contract.md)
- External effects follow [Injected I/O and HTTP](../patterns/injected-io-and-http.md).

## Functional Specification

### Mechanism

1. `main.ts` captures production dependencies with `realDeps()` and passes user arguments to `runCli()`.
2. `runCli()` creates the Commander program and a mutable session, then parses arguments without calling `process.exit()`.
3. `createProgram()` defines global flags and registers the Jira, Confluence, search, doctor, config, skill, and help command groups.
4. Registered commands normally use `attach()` with a `read` or `write` classification and an asynchronous handler; `lassi help` is a context-free exception implemented as a direct Commander action.
5. `attach()` obtains global and command options, builds the per-command context, and rejects a classified write immediately when read-only mode is active.
6. The handler receives the context, positional arguments, and options, and returns a `CommandResult` or no result.
7. The wrapper renders one selected stdout representation: pretty JSON, compact AXI/TOON, or command-authored Markdown.
8. If the result carries a batch error, successful output is written first and the error then follows the normal failure path.
9. Structured failures are enriched and rendered; unexpected values become `internal` errors. The session receives the mapped exit code.
10. `runCli()` handles Commander parse/help outcomes outside command actions, and `main.ts` assigns `process.exitCode` so buffered output can flush.

### Validation Rules

- `--json` and `--axi` are mutually exclusive, whether selected by flags or configuration.
- Extra positional arguments are rejected by Commander.
- Every attached command declares exactly one kind: `read` or `write`.
- A write cannot enter its handler under active read-only mode unless `--dry-run` is set.
- Write handlers call `guardWrite()` before sending remote mutations, starting an index build, or installing skill files. Preparatory reads and validation happen before that decision.
- JSON output is one complete JSON document; AXI output is one root object followed by any non-empty help lines supplied by the command or fallback suggestions.
- The attached-command wrapper and `guardWrite()` redact text before writing it; `ctx.deps.stdout` and `ctx.deps.stderr` are raw streams.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| `LASSI_READ_ONLY` is empty, `0`, `false`, `no`, or `off` | Read-only mode is disabled; any other defined spelling enables it. |
| Read-only plus `--dry-run` | The handler may prepare a preview, but `guardWrite()` returns `dry-run` and sends no remote request. |
| A read command exports or downloads local files, or caches metadata | It is allowed to write those local outputs. Search indexing and skill installation are classified as writes and are blocked by read-only mode. |
| Handler returns no value | The wrapper treats it as an empty successful result. |
| AXI result has no explicit payload | A non-empty `{ ok: true }` data object is rendered. |
| Batch has successes and a final error | Success data is printed, then the structured error is written and its nonzero exit code wins. |
| Commander displays help or version | The invocation exits 0. |
| Commander rejects syntax | Its human error remains, a JSON `usage` envelope is appended, and exit code is 2. |
| An unknown exception escapes a handler | It is wrapped as `internal` and exits 1. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `CommandSpec` | `kind`, `run` | Couples safety classification to the handler attached to a command. |
| `CommandResult` | `data`, `markdown`, `trailer`, `axi` | Provides format-specific successful output. |
| `CommandResult` | `exitCode`, `error` | Supports explicit success status and partial-success batch failure. |
| `Session` | `exitCode` | Carries the action result out of Commander's asynchronous callback. |
| `GlobalFlags` | `json`, `axi`, `dryRun`, `config`, `quiet`, `verbose` | Controls context creation and global execution behavior. |
| `DryRunPreview` | `method`, `path`, `payloadLabel`, `payload`, `note` | Describes the request a write would send without including credentials. |

### Services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `cli.ts` | `createProgram()` | Defines global behavior and invokes every command registrar. |
| `run-command.ts` | `attach()` | Wraps handlers with context, safety, output, error, and exit behavior. |
| `context.ts` | `buildContext()` | Creates the effective command services and output mode. |
| `guard-write.ts` | `assertWriteAllowed()` | Applies the pre-handler and pre-send read-only check. |
| `guard-write.ts` | `guardWrite()` | Renders Markdown dry-run detail or authorizes the remote send. |
| `run.ts` | `runCli()` | Owns parsing and top-level Commander outcomes. |
| `output/json.ts` | `toJsonDocument()` | Produces a newline-terminated, indented JSON document. |
| `output/axi.ts` | `renderAxi()` | Produces token-efficient TOON data and optional next-step help. |
| `output/dry-run.ts` | `renderDryRun()` | Produces the human-readable mutation preview. |

### CLI Commands

| Command surface | Purpose |
|-----------|---------|
| `lassi jira issue …` / `lassi jira project …` | Issue operations include comments, attachments, transitions, links, components, and fix versions; project operations manage component and version catalogs. Instance-level `lassi jira link types` remains outside those groups; see [Jira Issue Workflows](./jira-issue-workflows.md). |
| `lassi jira fields`, `lassi jira templates`, `lassi jira digest` | Inspect configured field aliases and creation templates, or summarize personal activity. |
| `lassi confluence page …` | Page operations include footer comments and attachments. `lassi confluence comment delete` remains outside the page group because it addresses a comment by ID; see [Confluence Page Workflows](./confluence-page-workflows.md). |
| `lassi confluence search`, `lassi confluence tree`, `lassi confluence stats macros` | Search content, walk a page or space hierarchy, or report macro use and conversion statistics. |
| `lassi search …` | Builds, inspects, and queries the local semantic index. |
| `lassi doctor` | Diagnoses configuration and connectivity. |
| `lassi config show` | Displays effective configuration and provenance with secrets masked. |
| `lassi skills install` | Plans or installs agent-facing skill assets. |
| `lassi help` | Renders the complete command reference. |

Global flags are `--json`, `--axi`, `--dry-run`, `--config <path>`, `--quiet`, and `--verbose`; `-V`/`--version` prints version and Git SHA. `lassi help --all` shows `jira issue` and `jira project` groups, with issue components and fix versions under the former and project catalogs under the latter; it also shows the `confluence page` group.
Output defaults to Markdown, while `--json` favors complete machine data and `--axi` favors compact agent data with advisory command-aware suggestions.

Markdown output is command-authored and may include a newline-normalized GFM table, frontmatter-backed entity text, or a trailer. JSON serialization uses standard `JSON.stringify` semantics and is the escape hatch for full text that AXI intentionally abbreviates. AXI converts values through JSON semantics, wraps arrays and scalars in a root object, and can derive command-aware next steps when the handler does not supply its own help.

Quiet and verbose affect diagnostics, not result shape. Quiet retains error-level logging; verbose enables HTTP debug traces. Neither flag bypasses redaction.

Dry-run behavior has two coordinated surfaces. The early read-only assertion allows a dry-run to reach its handler, so the handler can parse files, resolve identifiers, validate state, and construct the exact mutation. The late `guardWrite()` repeats the read-only assertion and decides between rendering that mutation and issuing it. JSON or AXI handlers return structured preview data; Markdown preview text is written by the guard itself.

The command classification decides what read-only mode blocks. Remote product mutations, search indexing, and skill installation are classified as `write` and are blocked unless `--dry-run` is set. Export, attachment download, and `jira issue editmeta` are classified as `read`, so they may save local files. Read-only mode is not a filesystem sandbox.

## Integration Points

- **Depends on**: Commander, the [Runtime Context](../concepts/runtime-context.md), the [Error Contract](../concepts/error-contract.md), and injected host capabilities.
- **Used by**: Every registered Jira, Confluence, search, doctor, configuration, skill, and help handler.
- **External systems**: Product and embedding services are reached only by handlers through context-provided clients; execution itself performs no product-specific requests.

The wrapper's `commandPath()` removes the root program name and builds paths such as `jira issue get`. AXI suggestion selection uses that stable path with parsed arguments, options, and returned data; suggestions are advisory output, not extra commands executed by the CLI.

## Extension Guide

Create a Commander command under the relevant command group, then call `attach()` with the correct `kind`. Keep argument parsing in the registration layer and put behavior in the handler. Return `data` for JSON and AXI, plus `markdown` when the default view needs tailored prose or a table.

For a remote mutation, build a credential-free `DryRunPreview` after all local validation and conversion. Call `guardWrite()` immediately before the client write; return the format-appropriate preview result when it says `dry-run`, otherwise send. Do not classify a remote read as a write merely because it saves an export locally.

Throw `LassiError` with context facts the hint catalogue can use. Let `attach()` enrich and render it; do not print ad hoc failures or assign exit codes in individual handlers. Return new output in `CommandResult`; if a handler must write to a raw `ctx.deps` stream, call `ctx.redact()` on the text first.

When adding a new top-level capability, export a register function and invoke it from `createProgram()`; unattached helpers are not public CLI commands. Preserve `.exitOverride()` and asynchronous parsing so tests can exercise failures without terminating their process.

If a command can partially succeed, return the successful `data` or Markdown together with `error`. Do not catch and print the error inside the handler: the wrapper must remain responsible for enrichment, redaction, stderr shape, and the final exit code.

Use `optsWithGlobals()` so global flags work before or after subcommands. Keep complete data in `CommandResult` even when Markdown or AXI abbreviates it, and redact any text written directly to a raw dependency stream.
