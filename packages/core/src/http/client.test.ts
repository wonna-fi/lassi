import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { createRedactor } from '../logging/redact.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { createHttpClient } from './client.js';

const BASE = 'https://jira.example.internal/jira';
const TOKEN = 'secret-pat-token';

function client(
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof createHttpClient>[0]> = {}
) {
  const sleeps: number[] = [];
  const c = createHttpClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch,
    product: 'jira',
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    ...extra,
  });
  return { c, sleeps };
}

describe('createHttpClient', () => {
  it('sends Bearer + Accept on GET and adds Content-Type only with a JSON body', async () => {
    const fetch = fakeFetch([
      { method: 'GET', path: '/jira/rest/api/2/myself', json: { name: 'jsmith' } },
      { method: 'POST', path: '/jira/rest/api/2/issue', status: 201, json: { key: 'PROJ-1' } },
    ]);
    const { c } = client(fetch);
    expect(await c.get('/rest/api/2/myself')).toEqual({ name: 'jsmith' });
    expect(await c.post('/rest/api/2/issue', { fields: { summary: 'x' } })).toEqual({
      key: 'PROJ-1',
    });
    const [get, post] = fetch.calls;
    expect(get?.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
    expect(post?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(post?.bodyText).toBe('{"fields":{"summary":"x"}}');
  });

  it('getText returns the raw body of XML and text answers', async () => {
    const fetch = fakeFetch([
      {
        path: '/jira/rest/applinks/1.0/manifest',
        text: '<manifest><version>8.5.10</version></manifest>',
        headers: { 'content-type': 'application/xml' },
      },
    ]);
    const { c } = client(fetch);
    expect(await c.getText('/rest/applinks/1.0/manifest')).toBe(
      '<manifest><version>8.5.10</version></manifest>'
    );
    expect(fetch.calls[0]?.headers['accept']).toContain('application/xml');
    expect(fetch.calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('appends query parameters, repeating arrays', async () => {
    const fetch = fakeFetch([{ path: '/jira/rest/api/2/search', json: {} }]);
    const { c } = client(fetch);
    await c.get('/rest/api/2/search', {
      query: { jql: 'a = "b"', maxResults: 5, expand: ['x', 'y'], skip: undefined },
    });
    expect(fetch.calls[0]?.url.search).toBe('?jql=a+%3D+%22b%22&maxResults=5&expand=x&expand=y');
  });

  it('returns undefined for 204 and non-JSON bodies', async () => {
    const fetch = fakeFetch([
      { method: 'PUT', path: '/jira/rest/api/2/issue/PROJ-1', status: 204 },
      { method: 'GET', path: '/jira/status', text: 'RUNNING' },
    ]);
    const { c } = client(fetch);
    expect(await c.put('/rest/api/2/issue/PROJ-1', { fields: {} })).toBeUndefined();
    expect(await c.get('/status')).toBeUndefined();
  });

  it('passes the Jira envelope through verbatim on 400 with the request path', async () => {
    const fetch = fakeFetch([
      {
        method: 'POST',
        path: '/jira/rest/api/2/issue',
        status: 400,
        json: { errorMessages: [], errors: { customfield_10001: 'Team is required.' } },
      },
    ]);
    const { c } = client(fetch);
    await expect(
      c.post('/rest/api/2/issue', { fields: {} }, { context: { project: 'PROJ' } })
    ).rejects.toMatchObject({
      name: 'LassiError',
      code: 'validation',
      http: 400,
      message: 'Team is required.',
      errors: { customfield_10001: 'Team is required.' },
      errorMessages: [],
      request: { method: 'POST', url: '/jira/rest/api/2/issue' },
      context: { product: 'jira', project: 'PROJ' },
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it('retries GET on 503 with backoff and succeeds', async () => {
    const fetch = fakeFetch([
      { method: 'GET', path: '/jira/rest/api/2/serverInfo', status: 503, times: 1, text: 'down' },
      { method: 'GET', path: '/jira/rest/api/2/serverInfo', json: { version: '9.12.0' } },
    ]);
    const { c, sleeps } = client(fetch);
    expect(await c.get('/rest/api/2/serverInfo')).toEqual({ version: '9.12.0' });
    expect(fetch.calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it('honours Retry-After on 429', async () => {
    const fetch = fakeFetch([
      {
        method: 'GET',
        path: '/jira/x',
        status: 429,
        times: 1,
        headers: { 'retry-after': '1' },
        text: 'slow down',
      },
      { method: 'GET', path: '/jira/x', json: { ok: true } },
    ]);
    const { c, sleeps } = client(fetch);
    await c.get('/x');
    expect(sleeps).toEqual([1000]);
  });

  it('never retries POST and reports the final status as http', async () => {
    const fetch = fakeFetch([
      { method: 'POST', path: '/jira/rest/api/2/issue/PROJ-1/comment', status: 503, text: 'down' },
    ]);
    const { c, sleeps } = client(fetch);
    await expect(c.post('/rest/api/2/issue/PROJ-1/comment', { body: 'x' })).rejects.toMatchObject({
      code: 'http',
      http: 503,
    });
    expect(fetch.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after maxAttempts', async () => {
    const fetch = fakeFetch([{ method: 'GET', path: '/jira/x', status: 502, text: 'bad' }]);
    const { c } = client(fetch, { retry: { maxAttempts: 2 } });
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'http', http: 502 });
    expect(fetch.calls).toHaveLength(2);
  });

  it('retries network errors on GET and classifies TLS failures', async () => {
    let calls = 0;
    const flaky: typeof globalThis.fetch = async () => {
      calls++;
      throw new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    };
    const { c } = client(flaky, { retry: { maxAttempts: 2 } });
    await expect(c.get('/x')).rejects.toMatchObject({
      code: 'tls',
      request: { method: 'GET', url: '/jira/x' },
    });
    expect(calls).toBe(2);
  });

  it('maps a deadline abort to a timeout error', async () => {
    const stalled: typeof globalThis.fetch = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    };
    const { c } = client(stalled, { retry: { maxAttempts: 1 }, timeoutMs: 5 });
    await expect(c.get('/x')).rejects.toMatchObject({
      code: 'timeout',
      message: 'request timed out after 5 ms',
    });
  });

  it('refuses to send the token to another origin, without calling fetch', async () => {
    const fetch = fakeFetch([]);
    const { c } = client(fetch);
    await expect(c.get('https://evil.example.com/x')).rejects.toMatchObject({ code: 'usage' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('accepts absolute same-origin URLs (attachment content links)', async () => {
    const fetch = fakeFetch([
      {
        path: '/jira/secure/attachment/1/a.png',
        bytes: new Uint8Array([1, 2, 3]),
        headers: {
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="a.png"',
        },
      },
    ]);
    const { c } = client(fetch);
    const dl = await c.download('https://jira.example.internal/jira/secure/attachment/1/a.png');
    expect(dl.contentType).toBe('image/png');
    expect(dl.filename).toBe('a.png');
    expect(dl.contentLength).toBe(3);
    const bytes = new Uint8Array(await new Response(dl.body).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(fetch.calls[0]?.headers.accept).toBe('*/*');
  });

  it('uploads multipart with X-Atlassian-Token and no explicit Content-Type', async () => {
    const fetch = fakeFetch([
      { method: 'POST', path: '/jira/rest/api/2/issue/PROJ-1/attachments', json: [{ id: '1' }] },
    ]);
    const { c } = client(fetch);
    const result = await c.uploadMultipart('/rest/api/2/issue/PROJ-1/attachments', [
      { field: 'file', data: 'hello', filename: 'note.txt', contentType: 'text/plain' },
    ]);
    expect(result).toEqual([{ id: '1' }]);
    const call = fetch.calls[0];
    expect(call?.headers['x-atlassian-token']).toBe('no-check');
    expect(call?.headers['content-type']).toBeUndefined();
    const file = call?.form?.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('note.txt');
    expect(await (file as File).text()).toBe('hello');
  });

  it('traces method, path, status and duration to the logger with tokens redacted', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (l) => lines.push(l),
      redact: createRedactor([TOKEN]),
    });
    const fetch = fakeFetch([{ path: '/jira/rest/api/2/myself', json: {} }]);
    const { c } = client(fetch, {
      logger,
      now: (() => {
        let t = 0;
        return () => (t += 7);
      })(),
    });
    await c.get('/rest/api/2/myself');
    expect(lines).toEqual([
      'debug: -> GET /jira/rest/api/2/myself (attempt 1/3)\n',
      'debug: <- 200 GET /jira/rest/api/2/myself 7ms\n',
    ]);
    expect(lines.join('')).not.toContain(TOKEN);
  });

  it('traces downloads and multipart uploads the same way, never the token or the bodies', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (l) => lines.push(l),
      redact: createRedactor([TOKEN]),
    });
    const fetch = fakeFetch([
      { path: '/jira/secure/attachment/1/a.png', bytes: new Uint8Array([1, 2, 3]) },
      { method: 'POST', path: '/jira/rest/api/2/issue/PROJ-1/attachments', json: [{ id: '1' }] },
    ]);
    const { c } = client(fetch, {
      logger,
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
    });
    await c.download('/secure/attachment/1/a.png');
    await c.uploadMultipart('/rest/api/2/issue/PROJ-1/attachments', [
      { field: 'file', data: 'secret body text', filename: 'note.txt' },
    ]);
    expect(lines).toEqual([
      'debug: -> GET /jira/secure/attachment/1/a.png (attempt 1/3)\n',
      'debug: <- 200 GET /jira/secure/attachment/1/a.png 5ms\n',
      'debug: -> POST /jira/rest/api/2/issue/PROJ-1/attachments (attempt 1/1)\n',
      'debug: <- 200 POST /jira/rest/api/2/issue/PROJ-1/attachments 5ms\n',
    ]);
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('secret body text');
  });

  it('surfaces an unmatched fake route loudly', async () => {
    const fetch = fakeFetch([]);
    const { c } = client(fetch);
    await expect(c.get('/nope')).rejects.toMatchObject({
      code: 'http',
      http: 599,
      message: 'fakeFetch: no route for GET /jira/nope',
    });
    expect(fetch.unmatched).toHaveLength(1);
  });

  it('does not retry a caller cancellation', async () => {
    // The signal is already aborted, so each remaining attempt fails at once and only the backoff
    // sleeps take time — while re-invoking the token provider on the way. A deadline abort still
    // retries: it is the server or the network that was slow, not the caller changing its mind.
    let calls = 0;
    const abort = async (): Promise<Response> => {
      calls += 1;
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    };
    const { c, sleeps } = client(abort as unknown as typeof globalThis.fetch);
    await expect(c.get('/rest/api/2/myself')).rejects.toMatchObject({
      code: 'timeout',
      message: 'request cancelled',
    });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);

    calls = 0;
    const timeout = async (): Promise<Response> => {
      calls += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    const retried = client(timeout as unknown as typeof globalThis.fetch);
    await expect(retried.c.get('/rest/api/2/myself')).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toBeGreaterThan(1);

    // `AbortSignal.timeout(…)` is an ordinary thing for a caller to pass and rejects with the same
    // name the client's own deadline uses, so the error name alone cannot say whose clock ran out.
    calls = 0;
    const signal = AbortSignal.timeout(1);
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true })
    );
    const own = client(timeout as unknown as typeof globalThis.fetch);
    await expect(own.c.get('/rest/api/2/myself', { signal })).rejects.toMatchObject({
      message: 'request cancelled',
    });
    expect(calls).toBe(1);
    expect(own.sleeps).toEqual([]);

    // Aborting during the backoff, with a live signal at the time of the failure: the next attempt
    // would otherwise spend a token-provider call and a request on a signal that is already dead.
    calls = 0;
    const controller = new AbortController();
    const reset = async (): Promise<Response> => {
      calls += 1;
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    };
    const during = client(reset as unknown as typeof globalThis.fetch, {
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(
      during.c.get('/rest/api/2/myself', { signal: controller.signal })
    ).rejects.toMatchObject({ message: 'request cancelled' });
    expect(calls).toBe(1);

    // The real sleep, not a stub: an abort during the backoff must clear the timer, or a CLI that
    // sets process.exitCode instead of calling exit stays alive for the rest of the delay.
    const late = new AbortController();
    const slow = createHttpClient({
      baseUrl: BASE,
      token: TOKEN,
      fetch: reset as unknown as typeof globalThis.fetch,
      product: 'jira',
      random: () => 0.5,
      now: () => 0,
    });
    const pending = slow.get('/rest/api/2/myself', { signal: late.signal });
    setTimeout(() => late.abort(), 5);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ message: 'request cancelled' });
    expect(Date.now() - started).toBeLessThan(1000);

    // An injected sleep that honours the signal by rejecting, the way timers/promises does: that is
    // a finished backoff, not a failure, and the caller must still get the client's error contract.
    const rejecting = new AbortController();
    calls = 0;
    const viaReject = client(reset as unknown as typeof globalThis.fetch, {
      sleep: async (_ms: number, signal?: AbortSignal) => {
        rejecting.abort();
        void signal;
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      },
    });
    await expect(
      viaReject.c.get('/rest/api/2/myself', { signal: rejecting.signal })
    ).rejects.toMatchObject({ code: 'timeout', message: 'request cancelled' });
    expect(calls).toBe(1);

    // A backoff that completes normally leaves nothing attached to a signal the caller reuses.
    const live = new AbortController();
    let attempts = 0;
    const twice = async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const reused = client(twice as unknown as typeof globalThis.fetch);
    await reused.c.get('/rest/api/2/myself', { signal: live.signal });
    expect(attempts).toBe(2);
  });
});
