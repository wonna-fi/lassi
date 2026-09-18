import type { Check, CheckResult } from '../types.js';
import { label, productState, PRODUCTS } from '../types.js';

const ENV_URL = { jira: 'LASSI_JIRA_URL', confluence: 'LASSI_CONFLUENCE_URL' } as const;

const CLEARTEXT_HINT =
  'use https: the credential goes in an Authorization header on the first request, and anything on the path can read it';

/** `http://` is legal (a local or test instance needs it) but never silent. */
const cleartext = (url: string): boolean => url.startsWith('http://');

export const configCheck: Check = async (ctx, shared) => {
  const out: CheckResult[] = [];
  for (const product of PRODUCTS) {
    const name = `${label(product)} config`;
    const section = ctx.config[product];
    const state = await productState(ctx, shared, product);
    if (!state.configured) {
      out.push({
        name,
        status: 'WARN',
        detail: 'not configured',
        hint: `set ${product}.url and ${product}.tokenFile in ~/.lassi.json (or ${ENV_URL[product]})`,
      });
      continue;
    }
    if (!section.url) {
      out.push({
        name,
        status: 'FAIL',
        detail: `${product}.url missing`,
        hint: `set ${product}.url or ${ENV_URL[product]}`,
      });
      continue;
    }
    if (state.error) {
      out.push({
        name,
        status: 'FAIL',
        detail: state.error.message,
        ...(state.error.hint ? { hint: state.error.hint } : {}),
      });
      continue;
    }
    const token = state.client?.token;
    const detail = `${section.url}; token from ${token?.source === 'env' ? 'environment' : token?.path}`;
    out.push(
      cleartext(section.url)
        ? { name, status: 'WARN', detail: `${detail} (sent in cleartext)`, hint: CLEARTEXT_HINT }
        : { name, status: 'PASS', detail }
    );
  }
  const embeddings = ctx.config.embeddings.url;
  if (embeddings !== undefined && cleartext(embeddings)) {
    out.push({
      name: 'Embeddings config',
      status: 'WARN',
      detail: `${embeddings} (API key sent in cleartext)`,
      hint: CLEARTEXT_HINT,
    });
  }
  return out;
};
