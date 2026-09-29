---
title: Injected I/O and HTTP
type: pattern
last_verified: 2026-09-29
sources:
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/core/src/fs/node.ts
  - packages/core/src/fs/types.ts
  - packages/core/src/http/*.ts
  - packages/core/src/testing/*.ts
  - packages/cli/src/context.ts
  - packages/cli/src/deps.ts
---

# Injected I/O and HTTP

## When to Use

Use this pattern for code that reads or writes files, calls a remote service, waits or retries, generates nondeterministic values, obtains credentials, or emits output. Inject capabilities that have portable abstractions so library code stays independent of Node process globals; keep host-specific boundary helpers such as `saveStream()` explicit and test the surrounding logic with offline, deterministic dependencies.

The available boundaries and configuration are defined by [Runtime Context](../concepts/runtime-context.md). Failures crossing them use the [Error Contract](../concepts/error-contract.md).

## Pattern

```typescript
import {
  createHttpClient,
  saveStream,
  type Logger,
} from '@wonna/lassi-core';

interface ReportDeps {
  fetch: typeof fetch;
  logger: Logger;
  token: string | (() => Promise<string>);
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

export async function downloadReport(
  deps: ReportDeps,
  input: { baseUrl: string; path: string; out: string; signal?: AbortSignal }
): Promise<{ bytes: number; unchanged?: boolean }> {
  // 1. Construct the client at the composition boundary from injected services.
  const http = createHttpClient({
    baseUrl: input.baseUrl,
    token: deps.token,
    fetch: deps.fetch,
    logger: deps.logger,
    random: deps.random,
    sleep: deps.sleep,
    now: deps.now,
  });

  // 2. Pass caller cancellation through the request and streamed body.
  const download = await http.download(input.path, { signal: input.signal });

  // 3. Use the Node-specific streaming helper for a bounded, conflict-safe download.
  return saveStream(download.body, input.out, {
    maxBytes: 50 * 1024 * 1024,
    preserveExisting: true,
    signal: input.signal,
  });
}
```

For ordinary library persistence, accept `LassiFs` and use its text/byte operations rather than importing `node:fs`. The CLI alone constructs `nodeFs()` and captures `fetch`, streams, environment, paths, clock, random source, sleep, build metadata, and Azure token acquisition in `realDeps()`.

Build an `HttpClient` with a static token or a token provider. A provider runs before every attempt, allowing short-lived credentials to refresh. The client refuses absolute URLs on another origin and follows only same-origin read redirects, preventing credentials from crossing a host boundary.

Keep dynamic identifiers in relative service paths and pass them through the client. It rejects `.` and `..` path segments before URL parsing can normalize them into a different resource; encoded dots, backslash separators, and parser-stripped whitespace do not bypass the check. An invalid path is a `usage` failure before a request is sent.

The client applies a deadline to headers and normal response bodies. A download's deadline ends once headers arrive; its body continues under the caller's cancellation signal so a valid large transfer is not mistaken for a stalled request. Some requests take the server minutes to answer. Such a request can raise its own deadline with `minTimeoutMs`, and a longer configured timeout still wins.

JSON methods accept an empty successful body, including HTTP 204. A nonempty 2xx body must parse as JSON even when its content type says otherwise. If it does not, the client raises an `http` failure with the status and a hint to check for an SSO login or proxy page; see [Error Contract](../concepts/error-contract.md).

Retries are a policy decision at the HTTP boundary. GET, HEAD, PUT, and DELETE can retry; POST retries only when the caller explicitly marks the endpoint idempotent. Retryable outcomes are network failures and statuses 429, 502, 503, and 504. Delay uses bounded full-jitter exponential backoff or a capped `Retry-After` value. Caller cancellation stops retrying and interrupts backoff. `retryOnTimeout: false` makes a request's own deadline final, because another attempt would only repeat the same slow work; network errors and retryable statuses still retry.

Stream remote bytes instead of buffering them. `saveStream()` counts actual bytes, enforces a hard cap even when `Content-Length` lies, writes to a unique partial file, and renames only after success. With `preserveExisting`, it publishes exclusively; identical existing bytes are reused, while different bytes raise a conflict and remain untouched. Partial files are removed on success and failure.

For tests, use `memFs()` and `fakeFetch()` from `@wonna/lassi-core/testing`. Queue explicit fake responses and inspect the recorded calls. [Tests and Fixtures](../conventions/tests-and-fixtures.md) defines the isolation requirements.

## Key Points

- Inject capabilities at the outermost composition boundary and pass the narrowest dependency shape required by each unit.
- Use `LassiFs` for library file access; instantiate `nodeFs()` only in host-facing composition code.
- Use `HttpClient` rather than raw fetch so authentication, origin checks, deadlines, retries, logging, and error classification remain consistent.
- Mark a POST idempotent only when the remote operation is safe to repeat.
- Keep caller cancellation attached to requests, backoff, and streaming saves.
- Use `saveStream()` for downloads that must enforce limits or avoid partial and overwritten files.
- Inject a token provider when credentials expire; keep static tokens as plain strings when they do not.
- Pass relative service paths so the client owns base-path joining and origin enforcement.
- Reject dot path segments before building a URL; a URL parser would otherwise change the addressed resource.
- Treat a nonempty, non-JSON 2xx API body as a failure, regardless of its content type.
- Inject `now()` alongside retry policy whenever HTTP-date `Retry-After` behavior must be deterministic.
- Give a read the server is known to answer slowly `minTimeoutMs` and `retryOnTimeout: false` instead of raising the timeout for every request.
- Feed every discovered credential into the shared redactor before any value can reach output.

## Reference Implementations

| File | Function/Method | Notes |
| --- | --- | --- |
| `packages/core/src/http/client.ts` | `createHttpClient()` | Centralizes injected transport, token refresh, deadlines, redirects, retries, and error conversion. |
| `packages/core/src/http/retry.ts` | `decideRetry()` | Pure retry table with injected time and randomness. |
| `packages/core/src/http/save.ts` | `saveStream()` | Streams to a temporary file and publishes completed bytes without overwriting a conflicting destination when preservation is enabled. |
| `packages/core/src/fs/node.ts` | `nodeFs()` | Production adapter implementing the library filesystem contract. |
| `packages/core/src/testing/mem-fs.ts` | `memFs()` | Deterministic in-memory `LassiFs` for tests. |
| `packages/core/src/testing/fake-fetch.ts` | `fakeFetch()` | Queued responses and recorded calls without network access. |
| `packages/cli/src/context.ts` | `buildContext()` | Composes injected dependencies into memoized service clients. |

## Anti-Patterns

**Do NOT:**

- Read `process.env`, call global `fetch`, or import `node:fs` inside reusable library logic.
- Put tokens into URLs, request references, log messages, dry-run previews, or test fixtures.
- Retry a write merely because it failed before a response was observed; the server may already have applied it.
- Apply a short request deadline to the full lifetime of a streaming download.
- Trust `Content-Length` as the enforcement mechanism for a download limit.
- Write a download directly onto its destination or silently replace an existing different file.
- Follow a write redirect or a redirect to another origin with credentials attached.
- Interpret an HTML login page returned with 2xx as an empty API success.
- Buffer an attachment only to save it when a web stream can flow directly to `saveStream()`.
- Construct production adapters inside reusable modules instead of receiving them from the host.
- Swallow a save conflict or delete the destination to make a retry appear successful.
