import { LassiError, type HintContext, type Product, type RequestRef } from './lassi-error.js';
import type { LassiErrorCode } from './codes.js';
import { parseErrorEnvelope } from './envelope.js';
import { classifyNetworkError } from './network.js';

export interface HttpFailure {
  status: number;
  statusText?: string;
  method: string;
  /** Path and query relative to the product base URL. */
  path: string;
  bodyText?: string;
  json?: unknown;
  product?: Product;
  context?: HintContext;
}

export function codeForStatus(status: number): LassiErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'validation';
  if (status === 409 || status === 412) return 'conflict';
  return 'http';
}

/** Turns a non-2xx response into an LassiError with the Atlassian envelope passed through verbatim. */
export function classifyHttpFailure(failure: HttpFailure): LassiError {
  const envelope = parseErrorEnvelope(failure.json);
  const firstFieldError = envelope.errors ? Object.values(envelope.errors)[0] : undefined;
  const message =
    envelope.message ??
    envelope.errorMessages?.[0] ??
    firstFieldError ??
    (failure.bodyText && failure.bodyText.trim().length > 0 && failure.bodyText.length <= 200
      ? failure.bodyText.trim()
      : undefined) ??
    (failure.statusText && failure.statusText.length > 0
      ? failure.statusText
      : `HTTP ${failure.status}`);

  const request: RequestRef = { method: failure.method, url: failure.path };
  const context: HintContext = { ...failure.context };
  if (failure.product) context.product = failure.product;

  return new LassiError(codeForStatus(failure.status), message, {
    http: failure.status,
    errors: envelope.errors,
    errorMessages: envelope.errorMessages,
    request,
    context,
  });
}

/** Wraps a `fetch` rejection (no HTTP response) as tls / timeout / network. */
export function fromNetworkError(
  err: unknown,
  request: RequestRef,
  opts: { timeoutMs?: number; product?: Product; cancelled?: boolean } = {}
): LassiError {
  // The caller knows something the rejection does not: `AbortSignal.timeout(…)` rejects with the
  // same name an internal deadline does, so only whoever holds the signal can say whose clock ran.
  const { kind, code } = opts.cancelled
    ? { kind: 'aborted' as const, code: undefined }
    : classifyNetworkError(err);
  const detail = code ? ` (${code})` : '';
  const context: HintContext = opts.product ? { product: opts.product } : {};
  switch (kind) {
    case 'tls':
      return new LassiError('tls', `TLS certificate verification failed${detail}`, {
        request,
        context,
        cause: err,
      });
    case 'timeout':
      return new LassiError(
        'timeout',
        `request timed out${opts.timeoutMs ? ` after ${opts.timeoutMs} ms` : ''}${detail}`,
        { request, context, cause: err }
      );
    case 'aborted':
      // Same code, so the exit-code table stays as it is; the message and hint say what happened.
      return new LassiError('timeout', `request cancelled${detail}`, {
        request,
        context,
        cause: err,
        hint: 'the request was cancelled through the signal passed to the client, not by a deadline',
      });
    case 'dns':
      return new LassiError('network', `host not found${detail}`, { request, context, cause: err });
    case 'refused':
      return new LassiError('network', `connection refused${detail}`, {
        request,
        context,
        cause: err,
      });
    case 'reset':
      return new LassiError('network', `connection reset${detail}`, {
        request,
        context,
        cause: err,
      });
    default: {
      const inner = err instanceof Error ? err.message : String(err);
      return new LassiError('network', `network error: ${inner}`, { request, context, cause: err });
    }
  }
}
