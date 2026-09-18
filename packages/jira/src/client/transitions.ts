import { LassiError } from '@wonna/lassi-core';
import type { JiraTransition } from './types.js';

/** Exact id, then case-insensitive name; ambiguity and misses are reported with the candidates. */
export function resolveTransition(
  list: JiraTransition[],
  nameOrId: string,
  issueKey: string
): JiraTransition {
  const byId = list.find((t) => t.id === nameOrId);
  if (byId) return byId;
  const wanted = nameOrId.trim().toLowerCase();
  const byName = list.filter((t) => t.name.toLowerCase() === wanted);
  if (byName.length === 1) return byName[0] as JiraTransition;
  const names = list.map((t) => `${t.name} (${t.id})`).join(', ');
  if (byName.length > 1) {
    throw new LassiError(
      'validation',
      `transition "${nameOrId}" is ambiguous; use the id: ${names}`,
      {
        context: { product: 'jira', issueKey, transition: true },
      }
    );
  }
  throw new LassiError(
    'not_found',
    `no transition "${nameOrId}" on ${issueKey}; available: ${names || 'none'}`,
    {
      hint: `run \`lassi jira transition list ${issueKey}\``,
      context: { product: 'jira', issueKey, transition: true },
    }
  );
}
