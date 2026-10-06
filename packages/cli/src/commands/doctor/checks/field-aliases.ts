import { isLassiError } from '@wonna/lassi-core';
import {
  CUSTOM_FIELD_ID,
  fieldAliases,
  fieldPolicy,
  isExcluded,
  isWritable,
  type FieldConfigEntry,
} from '@wonna/lassi-jira';
import type { Check, CheckResult } from '../types.js';
import { productState } from '../types.js';

interface FieldDef {
  id: string;
  name?: string;
}

/**
 * Needs no server, so it runs even when Jira is unreachable. A string alias of a custom field used
 * to be editable and is now read-only; the object form states either choice and is not flagged.
 */
function policyRow(entries: Record<string, FieldConfigEntry>): CheckResult {
  const name = 'Jira field policy';
  let policy;
  try {
    policy = fieldPolicy(entries);
  } catch (err) {
    if (!isLassiError(err)) throw err;
    return {
      name,
      status: 'FAIL',
      detail: err.message,
      ...(err.hint === undefined ? {} : { hint: err.hint }),
    };
  }
  // A string alias is read-only by default only when no entry for its field states a choice.
  const shorthand = Object.entries(entries).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' &&
      CUSTOM_FIELD_ID.test(entry[1]) &&
      policy.settings[entry[1]]?.editable === undefined
  );
  if (shorthand.length > 0) {
    const [alias, id] = shorthand[0] as [string, string];
    return {
      name,
      status: 'WARN',
      detail: `custom fields are read-only unless marked editable, including ${shorthand.map(([a]) => a).join(', ')}`,
      hint: `to keep editing one, write e.g. "${alias}": { "id": "${id}", "editable": true }; write "${alias}": { "id": "${id}" } to keep it read-only`,
    };
  }
  const ids = [...new Set(Object.values(policy.aliases))];
  const excluded = ids.filter((id) => isExcluded(policy, id)).length;
  const editable = ids.filter((id) => !isExcluded(policy, id) && isWritable(policy, id)).length;
  return {
    name,
    status: 'PASS',
    detail: `${editable} editable, ${ids.length - editable - excluded} read-only, ${excluded} excluded`,
  };
}

export const fieldAliasesCheck: Check = async (ctx, shared) => {
  const name = 'Jira field aliases';
  const entries = ctx.config.jira.fields;
  const aliases = Object.entries(fieldAliases(entries));
  if (aliases.length === 0) return [{ name, status: 'SKIP', detail: 'no aliases configured' }];
  const out: CheckResult[] = [policyRow(entries)];
  const state = await productState(ctx, shared, 'jira');
  if (!state.client) return [...out, { name, status: 'SKIP', detail: 'Jira not configured' }];
  let fields: FieldDef[];
  try {
    fields = (await state.client.http.get<FieldDef[]>('/rest/api/2/field')) ?? [];
  } catch (err) {
    return [
      ...out,
      { name, status: 'WARN', detail: `could not list fields: ${(err as Error).message}` },
    ];
  }
  const ids = new Set(fields.map((f) => f.id));
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
