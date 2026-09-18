import type { Check } from '../types.js';

/** Node's built-in fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1 (Node 24). */
export const proxyCheck: Check = async (ctx) => {
  const env = ctx.deps.env;
  const proxy = env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!proxy) return [{ name: 'Proxy', status: 'PASS', detail: 'no proxy variables set' }];
  const honoured =
    env['NODE_USE_ENV_PROXY'] === '1' || (env['NODE_OPTIONS'] ?? '').includes('--use-env-proxy');
  if (honoured)
    return [{ name: 'Proxy', status: 'PASS', detail: 'proxy variables set and honoured by Node' }];
  return [
    {
      name: 'Proxy',
      status: 'WARN',
      detail: 'HTTP(S)_PROXY is set but Node fetch ignores it',
      hint: 'export NODE_USE_ENV_PROXY=1 (or add --use-env-proxy to NODE_OPTIONS)',
    },
  ];
};
