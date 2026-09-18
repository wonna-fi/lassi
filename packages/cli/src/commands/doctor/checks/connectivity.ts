import { classifyNetworkError, deadlineSignal, type NetworkErrorKind } from '@wonna/lassi-core';
import type { Check, CheckResult } from '../types.js';
import { label, productState, PRODUCTS } from '../types.js';

const HINTS: Readonly<Record<NetworkErrorKind, string>> = {
  tls: 'set NODE_EXTRA_CA_CERTS=/path/to/custom-ca.pem (or NODE_USE_SYSTEM_CA=1)',
  dns: 'check the URL and VPN',
  timeout: 'check VPN and proxy (NODE_USE_ENV_PROXY=1 when a proxy is required)',
  // doctor passes no signal of its own, so this is unreachable here; the map stays total.
  aborted: 'the probe was cancelled before it finished',
  refused: 'check the URL and port',
  reset: 'check VPN and proxy',
  unknown: 'run with --verbose for the underlying error',
};

/** Unauthenticated `GET <url>/status` so TLS and routing problems are separated from bad tokens. */
export const connectivityCheck: Check = async (ctx, shared) => {
  const out: CheckResult[] = [];
  for (const product of PRODUCTS) {
    const name = `${label(product)} connectivity`;
    const state = await productState(ctx, shared, product);
    const url = ctx.config[product].url;
    if (!state.configured || !url) {
      out.push({ name, status: 'SKIP', detail: 'not configured' });
      continue;
    }
    try {
      const res = await ctx.deps.fetch(`${url}/status`, {
        signal: deadlineSignal(10_000),
        redirect: 'manual',
      });
      out.push({ name, status: 'PASS', detail: `reachable (HTTP ${res.status})` });
    } catch (err) {
      shared.unreachable.add(product);
      const { kind, code } = classifyNetworkError(err);
      out.push({
        name,
        status: 'FAIL',
        detail: `${kind === 'tls' ? 'TLS certificate not trusted' : `${kind} error`}${code ? ` (${code})` : ''}`,
        hint: HINTS[kind],
      });
    }
  }
  return out;
};
