---
title: Runtime Context
type: concept
last_verified: 2026-09-29
sources:
  - packages/core/src/http/save.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/core/src/config/*.ts
  - packages/core/src/auth/*.ts
  - packages/core/src/fs/*.ts
  - packages/cli/src/context.ts
  - packages/cli/src/deps.ts
---

# Runtime Context

## Business Definition

The runtime context is the per-command view of configuration and host capabilities. It gives every command consistent settings, credentials, output behavior, logging, filesystem access, time, and network clients without letting library code reach process globals directly.

## Configuration

| Source | Description |
|--------|-------------|
| `LassiConfigSchema` | Validates the complete effective configuration, rejects unknown keys, and supplies defaults. |
| `~/.lassi.json` | User-wide settings; `--config` or `LASSI_CONFIG` replaces this global file. |
| nearest `.lassi.json` | Workspace conventions found by walking upward from the current directory; sensitive routing and shared-storage keys are refused. |
| `LASSI_*` environment variables | Host URLs, credentials, embedding settings, and shared-storage overrides. Empty values are ignored. |
| global CLI flags | Per-invocation output and config choices. |

Effective precedence is defaults, global file, workspace file, environment, then flags. Layers merge by dotted leaf path, so a later partial object does not erase unrelated earlier fields. `LoadedConfig.sources` records the winning source for every effective leaf.

Workspace configuration is treated as untrusted repository input. Its allow-list permits team-facing Jira fields, templates, output, attachment, HTTP, and selected embedding settings, but excludes service URLs, inline `jira.token`, `confluence.token`, and `embeddings.apiKey`, credential-file paths, authentication modes, warning suppression, and shared export/index roots. The inline values could override a user's token file and select a different identity for requests. Workspace template files must remain inside the workspace config directory after symlink resolution, use a Markdown extension, avoid `.git`, and not resolve to a credential file.

Shared `storage.exportDir` and `storage.indexDir` paths resolve relative to the global config file or home directory, never the current workspace. The local `workspaceStateDir` is always `<cwd>/.lassi`.

**How to access:**

- `loadConfig()` - loads, validates, resolves, and annotates effective configuration.
- `buildContext()` - constructs the command context and its lazy clients.
- `Context.product()` - resolves a Jira or Confluence token and returns a memoized authenticated client.
- `Context.embeddings()` - resolves embedding authentication and returns a memoized embedding client configuration.
- `ENV_MAP` (constant) - maps supported environment variables to dotted configuration leaves.
- `WORKSPACE_CONFIG_NAME` (constant) - contains the workspace filename `.lassi.json`.

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `LassiConfig` | `jira`, `confluence` | Product URL, token source, defaults, and product-specific settings. |
| `LassiConfig` | `output` | Selects JSON, AXI, or default Markdown rendering. |
| `LassiConfig` | `attachments`, `storage` | Controls local attachment limits and stable export/index roots. |
| `LassiConfig` | `http` | Sets the default request timeout, which a known-slow request may raise for itself, and total retry attempts. |
| `LassiConfig` | `embeddings` | Configures the OpenAI-compatible endpoint, authentication, model, chunking, and query threshold. |
| `LoadedConfig` | `sources`, `files` | Records provenance for leaves and the files that participated in loading. |
| `LoadedConfig` | `workspaceStateDir`, `rawWorkspace`, `secrets` | Carries local state location, audit input, and environment-provided secrets. |
| `Context` | `deps`, `config`, `loaded` | Exposes injected host services and effective configuration. |
| `Context` | `format`, `dryRun`, `readOnly` | Holds command-wide output and write-safety decisions. |
| `Context` | `logger`, `redact` | Routes diagnostics and masks every known secret. |
| `CliDeps` | `fetch`, `fs`, `stdin`, `stdout`, `stderr` | Defines all command I/O boundaries. |
| `CliDeps` | `cwd`, `homedir`, `platform`, `env` | Supplies the host environment without direct global reads. |
| `CliDeps` | `now`, `random`, `sleep`, `azureToken` | Makes time, retry behavior, and dynamic credentials replaceable. |

Credentials are not eagerly read. Product tokens prefer a non-empty environment value over `tokenFile`; embedding credentials use the same environment-then-file rule unless `azure-ad` requests a fresh token provider. Environment and file values are BOM-stripped and trimmed before use. Missing, unreadable, or empty values, and normalized values containing a control character, become `auth` errors. This includes an embedded line break in either an environment value or a file value.

The schema enforces these cross-field constraints after layering:

| Constraint | Result |
|------------|--------|
| `output.json` and `output.axi` are both true | Loading fails because one invocation has one output format. |
| `embeddings.auth` is `azure-ad` with `apiKey` or `apiKeyFile` | Loading fails rather than silently ignoring the key. |
| `embeddings.azureScope` is explicitly set for another auth mode | Loading fails because the scope would have no effect. |
| `embeddings.chunkOverlap` is not smaller than `chunkChars` | Loading fails before indexing. |
| A Jira template sets both `description` and `descriptionFile` | Loading fails because the description source is ambiguous. |
| A Jira template name contains characters outside letters, digits, `-`, and `_` | Loading fails with the naming rule. |

Configuration URLs must use HTTP or HTTPS and are normalized without trailing slashes. Numeric settings validate their operational bounds: HTTP timeout and attachment size are positive, retries are between one and ten total attempts, embedding batch size is at most 2048, and query score is below one.

Product token-file paths and embedding key-file paths expand a leading home marker. Template description paths are resolved relative to the configuration file that supplied that leaf, allowing a versioned workspace config to refer to a sibling Markdown template independently of the command's current subdirectory.

`LassiFs` is the shared filesystem contract for library persistence and CLI state. It covers UTF-8 and byte reads/writes, exclusive creation, metadata, directory traversal, copying, deletion, rename, and symlink-resolving `realpath()`. Streaming downloads use the Node-specific `saveStream()` helper described in [Injected I/O and HTTP](../patterns/injected-io-and-http.md).

The production `nodeFs()` adapter creates parent directories for writes and copies. Its exclusive text write uses create-only mode and cleans up a newly created file when the write itself fails. Tests can replace the complete interface rather than patching individual Node functions.

`CliDeps.stdin` distinguishes an interactive terminal from piped input and exposes one whole UTF-8 read. Output dependencies accept complete text fragments, while `now`, `random`, and `sleep` make dates and retry timing deterministic. `buildInfo` and `repoRoot` locate distribution assets without making commands infer the source layout.

Azure authentication is also a host dependency. The production implementation lazily loads `DefaultAzureCredential`, applies the configured timeout, caches one token per scope, and refreshes it two minutes before expiry. `Context.embeddings()` exposes only a token provider to the HTTP client.

The effective context separates configuration from constructed clients:

| Access | Construction behavior |
|--------|-----------------------|
| `ctx.config` | Available immediately after validation; contains no source metadata. |
| `ctx.loaded` | Retains provenance, file paths, raw workspace input, and state-directory location. |
| `ctx.product('jira')` | Requires a Jira URL, resolves its token once, and memoizes the client promise. |
| `ctx.product('confluence')` | Applies the same contract independently for Confluence. |
| `ctx.embeddings()` | Requires endpoint and model, then selects bearer, API-key, or Azure AD authentication. |

Product clients expose the product, normalized base URL, authenticated HTTP client, and token resolution metadata. Embedding clients expose only settings required by indexing and querying; callers do not need to know whether the credential was static or refreshed.

`Context.format` is decided once from effective output configuration. A CLI format flag overrides a configured default in both directions, so selecting AXI explicitly also disables configured JSON and vice versa.

The context reads `LASSI_READ_ONLY` separately from schema configuration because it is a runtime safety control, not a persistent leaf. Its enforcement belongs to [Command Execution](../features/command-execution.md).
Configuration loading similarly treats `LASSI_CONFIG` as a file selector rather than an effective configuration leaf.

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-core` | `loadConfig()` | Builds an effective, validated configuration with source provenance. |
| `@wonna/lassi-core` | `resolveToken()` | Resolves a product token from environment input or a file. |
| `@wonna/lassi-core` | `resolveSecret()` | Applies the shared secret resolution and error contract. |
| `@wonna/lassi-core` | `findWorkspaceConfig()` | Finds the closest `.lassi.json` while walking toward the filesystem root. |
| `@wonna/lassi-core` | `nodeFs()` | Constructs the production implementation of `LassiFs`. |
| `packages/cli/src/context.ts` | `buildContext()` | Composes configuration, redaction, logging, safety state, and lazy clients. |
| `packages/cli/src/deps.ts` | `realDeps()` | Captures the production process, filesystem, clock, fetch, and Azure dependencies. |

## Internal Implementation

- Configuration paths are flattened before merging and unflattened only for schema validation. This makes provenance and precedence apply independently to each leaf and prevents empty objects from wiping prior values.
- Client promises are cached before resolution completes. Concurrent callers share token resolution and construction, and a command does not create clients for products it never uses.
- The redactor closes over a mutable secret set. Tokens discovered after context creation are therefore masked by the same logger and output boundary.
- Path helpers choose POSIX or Windows semantics from the path shape, so persisted and displayed paths remain stable across WSL and cross-platform tests.
- Workspace config identity comparisons follow symlinks. The global file cannot be loaded again as a higher-precedence workspace file through another spelling.

## Reference Implementations

- `packages/core/src/config/load.ts` - complete layered loading, workspace restrictions, path resolution, and provenance handling.
- `packages/core/src/config/schema.ts` - the effective configuration shape and defaults.
- `packages/core/src/auth/secret.ts` - shared environment-or-file credential resolution.
- `packages/core/src/fs/types.ts` - host-independent filesystem surface.
- `packages/core/src/fs/paths.ts` - cross-platform resolution, display, and portable storage behavior.
- `packages/cli/src/context.ts` - composition of effective configuration into one command context.
- `buildContext()` - reference for adding a lazily constructed service to the CLI context.
- `realDeps()` - production binding for every injected CLI dependency.

## Related Concepts

- [Error Contract](./error-contract.md)
- The lifecycle that constructs and consumes this context is documented in [Command Execution](../features/command-execution.md).
