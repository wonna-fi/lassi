---
title: Error Contract
type: concept
sources:
  - packages/cli/src/commands/search/index.ts
  - packages/cli/src/commands/skills/install.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/core/src/errors/*.ts
  - packages/core/src/logging/*.ts
  - packages/core/src/http/client.ts
  - packages/cli/src/run-command.ts
  - packages/cli/src/run.ts
last_verified: 2026-09-19
---

# Error Contract

## Business Definition

The error contract turns usage, service, safety, and infrastructure failures into stable machine-readable categories with actionable human guidance. Every command failure has a predictable exit code and emits both a one-line explanation and a JSON envelope on standard error.

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `LassiError` | `code`, `message`, `http` | Identifies the stable category, explanation, and optional HTTP status. |
| `LassiError` | `errors`, `errorsByAlias`, `errorMessages` | Preserves Jira field errors, configured aliases, and server message lists. |
| `LassiError` | `hint`, `context` | Carries the next action or the facts used to select one. |
| `LassiError` | `request` | Records only method and path/query; origins, headers, and bodies are excluded. |
| `ErrorJson` | ordered projection | Emits `code`, optional `http`, `message`, optional server details, `hint`, and `request`. |

The stable categories and exit codes are:

| Code | Exit | Meaning |
|------|------|---------|
| `usage` | 2 | Invalid arguments, configuration, or invocation. |
| `auth` | 3 | Missing, unreadable, empty, or rejected credentials. |
| `not_found` | 4 | The requested remote entity does not exist. |
| `validation` | 5 | Input or a remote validation rule rejected the operation. |
| `conflict` | 6 | Optimistic state or preserved local content conflicts. |
| `read_only` | 7 | A command classified as a write was blocked by runtime policy, including search indexing and local skill installation. |
| `network`, `tls`, `timeout`, `http`, `internal` | 1 | Connectivity, protocol, unclassified HTTP, or unexpected failures. |

HTTP 401/403 becomes `auth`, 404 becomes `not_found`, 400/422 becomes `validation`, and 409/412 becomes `conflict`; other non-success statuses become `http`. Fetch failures are classified by walking their cause chain for TLS, DNS, refusal, reset, timeout, and abort signals.

Atlassian response bodies retain useful structured detail. Jira `errors` and `errorMessages`, Confluence `message`, and nested Confluence error translations are copied into the envelope; short unstructured response bodies or status text provide the fallback message.

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-core` | `exitCodeFor()` | Maps an error category to the process contract. |
| `@wonna/lassi-core` | `isLassiError()` | Recognizes the structured type across package copies using its shape. |
| `@wonna/lassi-core` | `classifyHttpFailure()` | Converts a non-success HTTP response and envelope into `LassiError`. |
| `@wonna/lassi-core` | `fromNetworkError()` | Converts fetch rejection into network, TLS, or timeout categories. |
| `@wonna/lassi-core` | `parseErrorEnvelope()` | Extracts supported Jira and Confluence server details. |
| `@wonna/lassi-core` | `attachAliases()` | Adds configured Jira field aliases without replacing raw field IDs. |
| `@wonna/lassi-core` | `pickHint()` | Selects the first matching recovery hint from contextual facts. |
| `@wonna/lassi-core` | `toErrorJson()` | Produces the ordered machine-readable projection. |
| `@wonna/lassi-core` | `toStderr()` | Renders one human line and one JSON line through a redactor. |
| `@wonna/lassi-core` | `createRedactor()` | Replaces every known secret of at least four characters with `***`. |
| `packages/cli/src/run-command.ts` | `enrichError()` | Adds config-derived aliases, token-file context, and a catalogue hint. |

The hint catalogue is ordered and first-match wins. It covers read-only recovery; credential, TLS, timeout, and network checks, with a separate timeout hint for slow Jira edit metadata; conflict refetch commands; Jira metadata commands for invalid fields and transitions, including refreshing cached allowed values; Confluence validation; and product-specific not-found lookup suggestions. A hint supplied by the thrower takes precedence.

`HintContext` is deliberately facts rather than prose. Throwers can supply product, issue or page identity, project and issue type, working and credential file paths, aliases, version movement, allowed values, transition state, and operation kind. The CLI adds facts available only after configuration, such as when the allowed values a Jira update checked were cached. The catalogue then turns them into a concrete command or remediation.

The error envelope keeps raw service information and convenience information separate:

| Information | Contract behavior |
|-------------|-------------------|
| Jira field IDs | Remain unchanged in `errors`. |
| Configured Jira aliases | Appear additionally in `errorsByAlias`; the raw map is not rewritten. |
| Jira `errorMessages` | Remain an ordered string list. |
| Confluence nested messages | Flatten to `errorMessages`, preferring translation text over message keys. |
| Request reference | Contains method and relative path/query only. |
| Cause | Remains on the JavaScript error for diagnosis but is omitted from JSON. |

Message selection prefers the server's top-level message, then its first message-list entry, first field error, a non-empty response body of at most 200 characters, status text, and finally `HTTP <status>`. A malformed or unrelated JSON shape contributes no structured fields.

Rendering uses `error: <message>` for local failures, includes the product and HTTP status for known remote failures, collapses embedded newlines in the human line, and then writes the JSON object on its own line. Commander parse failures already have a human line, so the top-level runner appends only their JSON envelope.

Redaction is an output boundary, not a logging convention. Logger lines, normal command output, dry-run previews, and both error lines pass through the context redactor. Values shorter than four characters are deliberately ignored to avoid replacing ordinary text.

The logger has `silent`, `error`, `warn`, `info`, and `debug` thresholds and emits stable, uncolored `level: message` lines to stderr. HTTP tracing uses it for method, relative path, attempt, response, elapsed time, and retry delay; it never needs a credential, origin, request body, or response body.

Cancellation is represented with the `timeout` category to preserve the exit-code table, but its message says `request cancelled` and its explicit hint identifies the caller signal. Internal deadlines instead say the request timed out and can include the effective deadline, which a request may raise above the configured timeout.

Consumers may return a `LassiError` after emitting successful batch items. The command wrapper still renders the same envelope and nonzero category exit, so partial success does not create a second failure protocol.

The JSON envelope omits absent optional fields rather than emitting nulls. This keeps local usage failures compact while preserving remote detail when available.

Errors created before a context exists cannot use its accumulated secret set. Top-level parsing therefore renders only argument text supplied by Commander, while command and service failures use the context redactor.

An unknown thrown value is never allowed to escape as a second protocol. Within an attached command it becomes `LassiError('internal', ...)`; outside command actions the top-level runner writes the same human-plus-JSON shape and exits 1.

`EXIT_CODES` is the exported source of truth; callers use `exitCodeFor()` instead of maintaining command-specific mappings.

## Internal Implementation

- `isLassiError()` checks `name` and a string `code` instead of `instanceof`, so errors remain recognizable when multiple installed package copies or realms are involved.
- Network classification inspects up to four linked causes because Node's fetch implementation commonly wraps socket failures.
- Alias attachment preserves server field IDs while adding a separate `errorsByAlias` view; callers can diagnose the raw response and use configured names.
- `toErrorJson()` inserts the optional HTTP status between `code` and `message`; key order is a documented serialization contract.
- Human rendering derives the product label only for Jira and Confluence, while generic HTTP failures retain a product-neutral line.

## Reference Implementations

- `packages/core/src/errors/lassi-error.ts` - canonical error shape and contextual hint facts.
- `packages/core/src/errors/classify.ts` - HTTP status, server-envelope, and transport classification boundary.
- `packages/core/src/errors/render.ts` - stable human and JSON stderr rendering.
- `packages/core/src/errors/hints.ts` - ordered recovery-hint catalogue.
- `packages/core/src/logging/redact.ts` - secret masking applied at output boundaries.
- `packages/core/src/logging/logger.ts` - thresholded, redacted diagnostic output.
- `packages/cli/src/run-command.ts` - catches handler failures, enriches them, renders them, and selects the exit code.

Code that detects a failure should throw the most specific stable category and attach facts it knows. It should not choose an exit code, construct the final human sentence, duplicate an alias lookup, or print directly; those are centralized by this contract.

## Related Concepts

- [Runtime Context](./runtime-context.md)
- Error handling in the observable command lifecycle is documented in [Command Execution](../features/command-execution.md).
