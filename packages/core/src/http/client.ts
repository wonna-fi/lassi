import { LassiError, isLassiError, type HintContext, type Product } from '../errors/lassi-error.js';
import { classifyHttpFailure, fromNetworkError } from '../errors/classify.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  createDeadline,
  isAbortError,
  isTimeoutError,
} from './deadline.js';
import {
  DEFAULT_RETRY_POLICY,
  canRetry,
  decideRetry,
  type HttpMethod,
  type RetryPolicy,
} from './retry.js';

/** Fetches a fresh bearer token when a static one does not exist (Entra ID via `az login`). */
export type TokenProvider = () => Promise<string>;

export interface HttpClientOptions {
  /** Product base URL including any context path, without a trailing slash. */
  baseUrl: string;
  /** A static secret, or a provider called before every attempt so expiring tokens refresh. */
  token: string | TokenProvider;
  /** `bearer` (Atlassian PATs, OpenAI-style keys) or `api-key` (Azure OpenAI). */
  authScheme?: 'bearer' | 'api-key';
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  logger?: Logger;
  product?: Product;
  /** Injected for deterministic tests. */
  random?: () => number;
  /** The signal is passed on so a cancelled backoff can stop its timer; ignoring it is fine. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type QueryValue = string | number | boolean | undefined | Array<string | number>;

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  query?: Record<string, QueryValue>;
  /** Facts for the hint catalogue, attached to any error this request produces. */
  context?: HintContext;
  /** Lets a POST retry on 429/5xx/network like a GET; only for endpoints that are safe to repeat. */
  idempotent?: boolean;
}

export interface DownloadResult {
  status: number;
  contentType?: string;
  contentLength?: number;
  /** From Content-Disposition, when present. */
  filename?: string;
  body: ReadableStream<Uint8Array>;
}

export interface MultipartPart {
  field: string;
  data: Blob | Uint8Array | string;
  filename?: string;
  contentType?: string;
}

export interface HttpClient {
  readonly baseUrl: string;
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  /** Raw body as text, for XML endpoints such as the applinks manifest; retried like `get`. */
  getText(path: string, options?: RequestOptions): Promise<string>;
  /** Raw authenticated GET; the deadline covers the headers only, the body streams under `signal`. */
  download(path: string, options?: RequestOptions): Promise<DownloadResult>;
  /** `multipart/form-data` with `X-Atlassian-Token: no-check`; never retried. */
  uploadMultipart<T = unknown>(
    path: string,
    parts: MultipartPart[],
    options?: RequestOptions
  ): Promise<T>;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): URL {
  const base = new URL(baseUrl);
  let url: URL;
  if (/^https?:\/\//i.test(path)) {
    url = new URL(path);
    if (url.origin !== base.origin) {
      throw new LassiError(
        'usage',
        `refusing to send credentials to ${url.origin} (configured instance is ${base.origin})`
      );
    }
  } else {
    const basePath = base.pathname.replace(/\/+$/, '');
    url = new URL(`${base.origin}${basePath}${path.startsWith('/') ? path : `/${path}`}`);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1];
}

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The injected sleep, cut short when the caller's signal aborts. Backoff between attempts is the
 * one place a cancelled request would otherwise sit and wait for a deadline that no longer matters.
 */
async function abortableSleep(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return;
  // The signal reaches the sleep itself, so the default one can drop its timer. An injected sleep
  // is free to ignore it, which is what the race below is for.
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      // A sleep that honours the signal may reject rather than resolve — `timers/promises` does.
      // That is a finished backoff, not a failure: the caller's cancellation is turned into the
      // client's own error by the check after this call, and a raw AbortError would escape it.
      sleep(ms, signal).catch((err: unknown) => {
        if (!isAbortError(err)) throw err;
      }),
      new Promise<void>((resolve) => {
        onAbort = (): void => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  const logger = opts.logger ?? silentLogger;
  const random = opts.random ?? Math.random;
  // Clears its own timer on abort: a CLI sets `process.exitCode` rather than calling `exit`, so a
  // timer left pending would hold the process open for the rest of a backoff nobody is waiting for.
  const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      // Both paths detach the listener. `once` only covers the abort path, and a caller that reuses
      // one signal across a batch of requests would otherwise collect a closure per completed
      // backoff and hold every one of them until the signal aborts.
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  const authHeaders = (token: string, accept: string): Record<string, string> => ({
    ...(opts.authScheme === 'api-key'
      ? { 'api-key': token }
      : { Authorization: `Bearer ${token}` }),
    Accept: accept,
  });

  async function currentToken(context: HintContext): Promise<string> {
    if (typeof opts.token === 'string') return opts.token;
    try {
      return await opts.token();
    } catch (err) {
      if (isLassiError(err)) {
        err.context = { ...context, ...err.context };
        throw err;
      }
      const text = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
      throw new LassiError('auth', `could not obtain a token: ${text}`, { context, cause: err });
    }
  }

  interface Attempt {
    method: HttpMethod;
    url: URL;
    init: (token: string) => RequestInit;
    options: RequestOptions;
    /** When false, the deadline is not applied to the body (streaming downloads). */
    readBody: boolean;
    retryable: boolean;
  }

  /**
   * Where a redirect may lead. Only a same-origin GET is followed: the origin check the URL builder
   * does for an explicit path must hold for a redirect too, or a `Location` pointing elsewhere
   * would hand the credential to another host (undici strips `Authorization` across origins, but
   * not an `api-key` header). Anything else is reported rather than followed blindly.
   */
  function redirectTarget(
    response: Response,
    from: URL,
    attempt: { method: HttpMethod },
    request: { method: string; url: string },
    context: HintContext
  ): URL {
    const location = response.headers.get('location');
    const fail = (message: string, hint?: string): never => {
      throw new LassiError('http', message, {
        http: response.status,
        request,
        context,
        ...(hint === undefined ? {} : { hint }),
      });
    };
    if (!location) fail(`the server answered ${response.status} without a Location header`);
    let target: URL;
    try {
      target = new URL(location as string, from);
    } catch {
      return fail(`the server redirected to an unusable location: ${String(location)}`);
    }
    if (target.origin !== new URL(baseUrl).origin) {
      return fail(
        `refusing to follow a redirect to ${target.origin}; the credentials are for ${new URL(baseUrl).origin}`,
        'check the configured URL: a redirect to another host usually means an SSO portal or a wrong base URL'
      );
    }
    if (attempt.method !== 'GET') {
      return fail(
        `the server redirected a ${attempt.method}, which is not repeated automatically`,
        'check the configured URL; only reads follow redirects'
      );
    }
    return target;
  }

  async function run(attempt: Attempt): Promise<{ response: Response; text?: string }> {
    const displayPath = `${attempt.url.pathname}${attempt.url.search}`;
    const request = { method: attempt.method, url: displayPath };
    const baseContext: HintContext = { ...attempt.options.context };
    if (opts.product) baseContext.product = opts.product;

    // A non-retryable request (POST, uploads) gets exactly one attempt; the trace says so.
    const retryable = attempt.retryable && canRetry(attempt.method, attempt.options.idempotent);
    const maxAttempts = retryable ? policy.maxAttempts : 1;
    let url = attempt.url;
    let redirects = 0;
    for (let n = 1; ; n++) {
      // Token acquisition (an `az` subprocess, at worst) is not the endpoint's time: it runs
      // before the clock starts, the trace line and the deadline signal.
      const token = await currentToken(baseContext);
      const started = now();
      logger.debug(`-> ${attempt.method} ${displayPath} (attempt ${n}/${maxAttempts})`);
      // A download's body streams under the caller's signal once the headers are in; keeping the
      // deadline attached would abort every transfer that takes longer than one request may.
      const deadline = createDeadline(timeoutMs, attempt.options.signal);
      let response: Response;
      let text: string | undefined;
      try {
        response = await fetchImpl(url, {
          ...attempt.init(token),
          signal: deadline.signal,
          // Followed by hand below: `follow` would carry a credential header that is not
          // `Authorization` (an `api-key`) to whatever host the redirect names.
          redirect: 'manual',
        });
        // The body read stays inside the deadline: headers can arrive before the deadline while
        // the body stalls, and that must surface as a timeout, not a hang.
        if (attempt.readBody || !response.ok) text = await response.text();
      } catch (err) {
        deadline.clear();
        const elapsed = now() - started;
        // The caller's own signal decides, not the error name: `AbortSignal.timeout(…)` is a
        // perfectly ordinary thing for a caller to pass and rejects as `TimeoutError` too, exactly
        // like the deadline this client sets, so the name alone cannot say whose clock ran out.
        const cancelled =
          attempt.options.signal?.aborted === true || (!isTimeoutError(err) && isAbortError(err));
        const timedOut = !cancelled && isTimeoutError(err);
        // A cancellation is not a failure worth retrying: the signal is already aborted, so every
        // remaining attempt fails the moment it starts and only the backoff sleeps take any time —
        // and each one re-invokes the token provider on the way.
        const decision =
          retryable && !cancelled
            ? decideRetry(
                {
                  method: attempt.method,
                  attempt: n,
                  outcome: { kind: 'network', timedOut },
                  idempotent: attempt.options.idempotent ?? false,
                },
                policy,
                random
              )
            : { retry: false, delayMs: 0, reason: 'not retryable' };
        logger.debug(
          `<- ${timedOut ? 'timeout' : cancelled ? 'cancelled' : 'network error'} ${attempt.method} ${displayPath} ${elapsed}ms${decision.retry ? `; retrying in ${decision.delayMs}ms` : ''}`
        );
        if (decision.retry) {
          await abortableSleep(sleep, decision.delayMs, attempt.options.signal);
          // The caller may have aborted while we waited. Starting another attempt would spend a
          // token-provider call and a request on a signal that is already dead.
          if (attempt.options.signal?.aborted === true) {
            const error = fromNetworkError(err, request, {
              timeoutMs,
              product: opts.product,
              cancelled: true,
            });
            error.context = { ...baseContext, ...error.context };
            throw error;
          }
          continue;
        }
        const error = fromNetworkError(err, request, {
          timeoutMs,
          product: opts.product,
          ...(cancelled ? { cancelled } : {}),
        });
        error.context = { ...baseContext, ...error.context };
        throw error;
      }
      const elapsed = now() - started;
      deadline.clear();
      if (REDIRECT_STATUS.has(response.status)) {
        const target = redirectTarget(response, url, attempt, request, baseContext);
        if (redirects >= MAX_REDIRECTS) {
          throw new LassiError('http', `too many redirects from ${displayPath}`, {
            http: response.status,
            request,
            context: baseContext,
          });
        }
        logger.debug(`<- ${response.status} redirect to ${target.pathname}${target.search}`);
        url = target;
        redirects += 1;
        n -= 1;
        continue;
      }
      if (response.ok) {
        logger.debug(`<- ${response.status} ${attempt.method} ${displayPath} ${elapsed}ms`);
        return text === undefined ? { response } : { response, text };
      }
      const decision = retryable
        ? decideRetry(
            {
              method: attempt.method,
              attempt: n,
              outcome: {
                kind: 'response',
                status: response.status,
                retryAfter: response.headers.get('retry-after'),
              },
              now: now(),
              idempotent: attempt.options.idempotent ?? false,
            },
            policy,
            random
          )
        : { retry: false, delayMs: 0, reason: 'not retryable' };
      logger.debug(
        `<- ${response.status} ${attempt.method} ${displayPath} ${elapsed}ms${decision.retry ? `; retrying in ${decision.delayMs}ms` : ''}`
      );
      if (decision.retry) {
        await sleep(decision.delayMs);
        continue;
      }
      const bodyText = text ?? '';
      throw classifyHttpFailure({
        status: response.status,
        statusText: response.statusText,
        method: attempt.method,
        path: displayPath,
        bodyText,
        json: tryParseJson(bodyText),
        product: opts.product,
        context: baseContext,
      });
    }
  }

  async function json<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = buildUrl(baseUrl, path, options.query);
    const hasBody = body !== undefined;
    const { response, text } = await run({
      method,
      url,
      init: (token) => ({
        method,
        headers: {
          ...authHeaders(token, 'application/json'),
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
      options,
      readBody: true,
      retryable: true,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 204 || text === undefined || text.length === 0) return undefined as T;
    if (!contentType.includes('json')) return undefined as T;
    return parseJsonBody<T>(text, response.status, {
      method,
      url: buildUrl(baseUrl, path).pathname,
    });
  }

  /** A 200 whose JSON does not parse is an interstitial or a truncated body, not a bug here. */
  function parseJsonBody<T>(
    text: string,
    status: number,
    request: { method: string; url: string }
  ): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LassiError(
        'http',
        `the server answered ${status} with a body that is not JSON (${text.slice(0, 80).replace(/\s+/g, ' ').trim()})`,
        {
          http: status,
          request,
          hint: 'the instance may have answered with an SSO login page; check the URL and the token with `lassi doctor`',
          context: opts.product ? { product: opts.product } : {},
        }
      );
    }
  }

  return {
    baseUrl,
    get: (path, options) => json('GET', path, undefined, options),
    post: (path, body, options) => json('POST', path, body, options),
    put: (path, body, options) => json('PUT', path, body, options),
    delete: (path, options) => json('DELETE', path, undefined, options),

    async getText(path, options = {}) {
      const url = buildUrl(baseUrl, path, options.query);
      const { text } = await run({
        method: 'GET',
        url,
        init: (token) => ({
          method: 'GET',
          headers: {
            ...authHeaders(
              token,
              'text/plain, application/xml, text/xml, application/json;q=0.9, */*;q=0.8'
            ),
            ...options.headers,
          },
        }),
        options,
        readBody: true,
        retryable: true,
      });
      return text ?? '';
    },

    async download(path, options = {}) {
      const url = buildUrl(baseUrl, path, options.query);
      const { response } = await run({
        method: 'GET',
        url,
        init: (token) => ({
          method: 'GET',
          headers: { ...authHeaders(token, '*/*'), ...options.headers },
        }),
        options,
        readBody: false,
        retryable: true,
      });
      const lengthHeader = response.headers.get('content-length');
      const contentLength = lengthHeader === null ? undefined : Number(lengthHeader);
      const out: DownloadResult = {
        status: response.status,
        body: response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      };
      const contentType = response.headers.get('content-type');
      if (contentType) out.contentType = contentType.split(';')[0]?.trim();
      if (contentLength !== undefined && Number.isFinite(contentLength))
        out.contentLength = contentLength;
      const filename = filenameFromDisposition(response.headers.get('content-disposition'));
      if (filename) out.filename = filename;
      return out;
    },

    async uploadMultipart<T>(path: string, parts: MultipartPart[], options: RequestOptions = {}) {
      const url = buildUrl(baseUrl, path, options.query);
      const { response, text } = await run({
        method: 'POST',
        url,
        init: (token) => {
          const form = new FormData();
          for (const part of parts) {
            const blob =
              part.data instanceof Blob
                ? part.data
                : new Blob(
                    [typeof part.data === 'string' ? part.data : Buffer.from(part.data)],
                    part.contentType ? { type: part.contentType } : undefined
                  );
            if (part.filename) form.append(part.field, blob, part.filename);
            else form.append(part.field, blob);
          }
          return {
            method: 'POST',
            // No Content-Type: fetch adds the multipart boundary itself.
            headers: {
              ...authHeaders(token, 'application/json'),
              'X-Atlassian-Token': 'no-check',
              ...options.headers,
            },
            body: form,
          };
        },
        options,
        readBody: true,
        retryable: false,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (text === undefined || text.length === 0 || !contentType.includes('json'))
        return undefined as T;
      return parseJsonBody<T>(text, response.status, {
        method: 'POST',
        url: buildUrl(baseUrl, path).pathname,
      });
    },
  };
}
