---
title: "Feature: Skill Installation"
type: feature
sources:
  - packages/cli/src/run-command.ts
  - packages/cli/src/commands/skills/{install,plan,generated}.ts
  - packages/cli/src/commands/jira/reference.ts
  - packages/cli/src/cli.ts
  - packages/cli/src/guard-write.ts
  - skills/jira/**
  - skills/confluence/**
  - scripts/build-package.mjs
---

# Feature: Skill Installation

## Overview

Skill installation copies Lassi's Jira and Confluence agent guidance to a global or project-local discovery directory while protecting edited authored files and rebuilding generated references.

## Key Concepts

Before working with this feature, understand [Command Execution](./command-execution.md) and the [Runtime Context](../concepts/runtime-context.md).

## Functional Specification

### User Flow

1. Run `lassi skills install`, optionally with a project destination, one selected skill, or forced replacement.
2. Lassi classifies authored files as `create`, `same`, or `overwrite`, and generated references as `generate`.
3. A dry run reports the plan only when there are no authored-file conflicts or `--force` is supplied; otherwise conflict validation fails before preview rendering. Without a dry run, permitted authored files are copied and references are rendered.

### Validation Rules

- `--global` and `--project` are mutually exclusive.
- `--only` accepts `jira` or `confluence`.
- Differing authored files stop all writes unless `--force` permits replacement; generated files always refresh.
- The command is classified as a write even though it installs local files. Read-only mode blocks it unless `--dry-run` is set.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No destination option | Installs below `~/.agents/skills/`; relative projects resolve from the injected working directory into `.github/skills/`. |
| Generation lacks instance configuration | Writes a marked placeholder, logs a warning, and lets other files succeed. |

## Technical Implementation

### Data Model

| Model/Type | Key Fields | Purpose |
|--------|------------|---------|
| `InstallPlan` | `entries`, `conflicts` | Carries ordered relative paths, actions, and modified authored files. |

### Services and functions

These are internal CLI modules, not package-root APIs:

- `install.ts`: `registerSkills()` registers the command and applies the plan.
- `plan.ts`: `planInstall()` classifies files; `generatedHeader()` marks generated content.
- `generated.ts`: `registerGenerated()` registers reference generators.

### CLI Commands

| Command | Purpose |
|-----------|---------|
| `lassi skills install` | Installs both skills globally by default; supports `--project`, `--only`, `--force`, and dry-run. |

## Integration Points

- **Depends on**: packaged assets, generator registrations, injected filesystem/context services, and the common write guard.
- **Used by**: agents discovering Jira or Confluence instructions globally or under `.github/skills/`.
- **External systems**: Jira may supply instance-specific link types; unavailable configuration produces a placeholder.

## Extension Guide

Add an authored tree and installer allow-list entry, then package it with the CLI. Register volatile files with `registerGenerated()` so they bypass authored-file comparison and carry `generatedHeader()`. Keep `guardWrite()` immediately before mutation so read-only and dry-run behavior follows [Command Execution](./command-execution.md).
