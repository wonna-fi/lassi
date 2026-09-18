import { createConfluenceClient } from '@wonna/lassi-confluence';
import { isLassiError } from '@wonna/lassi-core';
import { majorOf, API_TARGETS } from '../baseline.js';
import type { Check, CheckResult } from '../types.js';
import { label, productState, PRODUCTS } from '../types.js';

interface JiraServerInfo {
  version?: string;
  deploymentType?: string;
}
export const versionsCheck: Check = async (ctx, shared) => {
  const out: CheckResult[] = [];
  for (const product of PRODUCTS) {
    const name = `${label(product)} version`;
    const state = await productState(ctx, shared, product);
    if (shared.unreachable.has(product)) {
      out.push({ name, status: 'SKIP', detail: 'unreachable (see connectivity)' });
      continue;
    }
    if (!state.client) {
      out.push({ name, status: 'SKIP', detail: 'not configured' });
      continue;
    }
    let version: string | undefined;
    let detail = '';
    try {
      if (product === 'jira') {
        const info = await state.client.http.get<JiraServerInfo>('/rest/api/2/serverInfo');
        version = info?.version;
        detail = `${version ?? 'unknown'}${info?.deploymentType ? ` (${info.deploymentType})` : ''}`;
      } else {
        // systemInfo needs admin rights on most instances; the applinks manifest does not
        //, and the space probe proves reachability when both are unavailable.
        const client = createConfluenceClient({
          baseUrl: state.client.baseUrl,
          http: state.client.http,
        });
        const info = await client.systemInfo();
        version = info.version;
        detail =
          info.source === 'space-probe'
            ? 'systemInfo endpoint unavailable; API reachable, version unknown'
            : `${info.version}${info.source === 'manifest' ? ' (via applinks manifest)' : ''}`;
      }
    } catch (err) {
      out.push({
        name,
        status: 'WARN',
        detail: `could not determine version: ${isLassiError(err) ? err.message : String(err)}`,
      });
      continue;
    }
    if (version) shared.versions[product] = version;
    const major = version ? majorOf(version) : undefined;
    if (major === undefined) {
      out.push({ name, status: 'WARN', detail });
    } else if (API_TARGETS[product].majors.includes(major)) {
      out.push({ name, status: 'PASS', detail });
    } else {
      out.push({
        name,
        status: 'WARN',
        detail: `${detail}; API compatibility target is ${API_TARGETS[product].majors.join('/')}.x`,
      });
    }
  }
  return out;
};
