export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  bodyText?: string;
  form?: FormData;
}

export interface RouteReply {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export interface Route extends RouteReply {
  method?: string;
  /** A string matches `pathname` exactly; a RegExp is tested against `pathname + search`. */
  path: string | RegExp;
  /** How many times this route may answer before it is skipped (default unlimited). */
  times?: number;
  handler?: (call: RecordedCall) => RouteReply | Response | Promise<RouteReply | Response>;
}

export type FakeFetch = typeof fetch & { calls: RecordedCall[]; unmatched: RecordedCall[] };

function toResponse(reply: RouteReply): Response {
  const headers: Record<string, string> = { ...reply.headers };
  let body: Uint8Array | null = null;
  if (reply.json !== undefined) {
    body = new TextEncoder().encode(JSON.stringify(reply.json));
    headers['content-type'] ??= 'application/json';
  } else if (reply.text !== undefined) {
    body = new TextEncoder().encode(reply.text);
    headers['content-type'] ??= 'text/plain';
  } else if (reply.bytes !== undefined) {
    body = reply.bytes;
    headers['content-type'] ??= 'application/octet-stream';
  }
  const status = reply.status ?? (body === null ? 204 : 200);
  // Real servers send Content-Length for these bodies; `new Response(bytes)` does not add it.
  if (body !== null && status !== 204) headers['content-length'] ??= String(body.byteLength);
  return new Response(status === 204 || body === null ? null : Buffer.from(body), {
    status,
    headers,
  });
}

function headersToRecord(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init as Array<[string, string]>) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(init as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/**
 * A `fetch` stand-in for tests. Records every call; an unmatched request answers 599 with a
 * distinctive body so the failure is obvious in the resulting error (never hits the network).
 */
export function fakeFetch(routes: Route[]): FakeFetch {
  const remaining = routes.map((r) => ({ route: r, left: r.times ?? Number.POSITIVE_INFINITY }));
  const calls: RecordedCall[] = [];
  const unmatched: RecordedCall[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const call: RecordedCall = { method, url, headers: headersToRecord(init?.headers) };
    const body = init?.body;
    if (typeof body === 'string') call.bodyText = body;
    else if (body instanceof FormData) call.form = body;
    calls.push(call);

    for (const entry of remaining) {
      const { route } = entry;
      if (entry.left <= 0) continue;
      if (route.method && route.method.toUpperCase() !== method) continue;
      const matches =
        typeof route.path === 'string'
          ? route.path === url.pathname
          : route.path.test(`${url.pathname}${url.search}`);
      if (!matches) continue;
      entry.left -= 1;
      if (route.handler) {
        const reply = await route.handler(call);
        return reply instanceof Response ? reply : toResponse(reply);
      }
      return toResponse(route);
    }
    unmatched.push(call);
    return new Response(`fakeFetch: no route for ${method} ${url.pathname}${url.search}`, {
      status: 599,
      headers: { 'content-type': 'text/plain' },
    });
  };

  return Object.assign(impl as typeof fetch, { calls, unmatched });
}
