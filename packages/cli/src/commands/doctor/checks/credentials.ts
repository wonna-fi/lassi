import { isLassiError } from '@wonna/lassi-core';
import type { Check, CheckResult } from '../types.js';
import { label, productState, PRODUCTS } from '../types.js';

const ENDPOINT = { jira: '/rest/api/2/myself', confluence: '/rest/api/user/current' } as const;

interface UserLike {
  name?: string;
  username?: string;
  displayName?: string;
  type?: string;
}

export const credentialsCheck: Check = async (ctx, shared) => {
  const out: CheckResult[] = [];
  for (const product of PRODUCTS) {
    const name = `${label(product)} credentials`;
    const state = await productState(ctx, shared, product);
    if (shared.unreachable.has(product)) {
      out.push({ name, status: 'SKIP', detail: 'unreachable (see connectivity)' });
      continue;
    }
    if (!state.client) {
      out.push({
        name,
        status: 'SKIP',
        detail: state.configured ? 'config check failed' : 'not configured',
      });
      continue;
    }
    try {
      const me = await state.client.http.get<UserLike>(ENDPOINT[product]);
      if (product === 'confluence' && me?.type === 'anonymous') {
        out.push({
          name,
          status: 'FAIL',
          detail: 'server answered anonymously; token not accepted',
          hint: `check the token in ${state.client.token.path ?? 'LASSI_CONFLUENCE_TOKEN'}`,
        });
        continue;
      }
      const who = me?.name ?? me?.username ?? me?.displayName ?? 'unknown user';
      out.push({ name, status: 'PASS', detail: `authenticated as ${who}` });
    } catch (err) {
      const message = isLassiError(err) ? err.message : String(err);
      const hint =
        isLassiError(err) && err.code === 'auth'
          ? `check the token in ${state.client.token.path ?? 'the environment'} (${err.http})`
          : undefined;
      out.push({ name, status: 'FAIL', detail: message, ...(hint ? { hint } : {}) });
    }
  }
  return out;
};
