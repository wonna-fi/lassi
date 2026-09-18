import { classifyMode } from '@wonna/lassi-core';
import type { Check, CheckResult } from '../types.js';
import { label, productState, PRODUCTS } from '../types.js';

export const tokenPermissionsCheck: Check = async (ctx, shared) => {
  const out: CheckResult[] = [];
  for (const product of PRODUCTS) {
    const name = `${label(product)} token file permissions`;
    const state = await productState(ctx, shared, product);
    const path = state.client?.token.path;
    if (!path) {
      out.push({
        name,
        status: 'SKIP',
        detail: state.client ? 'token from environment' : 'no token file',
      });
      continue;
    }
    if (!ctx.config.tokenPermissionWarning) {
      out.push({ name, status: 'SKIP', detail: 'tokenPermissionWarning is false' });
      continue;
    }
    const { mode } = await ctx.deps.fs.stat(path);
    const exposure = classifyMode(mode, ctx.deps.platform);
    if (exposure === 'ok') out.push({ name, status: 'PASS', detail: `${path} is private` });
    else if (exposure === 'not-applicable')
      out.push({ name, status: 'SKIP', detail: 'POSIX modes not applicable on this platform' });
    else
      out.push({
        name,
        status: 'WARN',
        detail: `${path} is ${exposure}`,
        hint: `chmod 600 ${path}; on WSL paths under /mnt/c set "tokenPermissionWarning": false`,
      });
  }
  return out;
};
