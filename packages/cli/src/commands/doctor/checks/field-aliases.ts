import type { Check, CheckResult } from '../types.js';
import { productState } from '../types.js';

interface FieldDef {
  id: string;
  name?: string;
}

export const fieldAliasesCheck: Check = async (ctx, shared) => {
  const name = 'Jira field aliases';
  const aliases = Object.entries(ctx.config.jira.fields);
  if (aliases.length === 0) return [{ name, status: 'SKIP', detail: 'no aliases configured' }];
  const state = await productState(ctx, shared, 'jira');
  if (!state.client) return [{ name, status: 'SKIP', detail: 'Jira not configured' }];
  let fields: FieldDef[];
  try {
    fields = (await state.client.http.get<FieldDef[]>('/rest/api/2/field')) ?? [];
  } catch (err) {
    return [{ name, status: 'WARN', detail: `could not list fields: ${(err as Error).message}` }];
  }
  const ids = new Set(fields.map((f) => f.id));
  const out: CheckResult[] = [];
  for (const [alias, id] of aliases) {
    if (ids.has(id))
      out.push({
        name: `alias ${alias}`,
        status: 'PASS',
        detail: `${id} (${fields.find((f) => f.id === id)?.name ?? '?'})`,
      });
    else
      out.push({
        name: `alias ${alias}`,
        status: 'WARN',
        detail: `${id} is not a field on this instance`,
        hint: 'run `lassi jira fields` and fix .lassi.json',
      });
  }
  return out;
};
