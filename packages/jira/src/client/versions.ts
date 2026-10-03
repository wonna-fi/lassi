import { LassiError } from '@wonna/lassi-core';
import { findByName, nameList, quoted } from './named.js';
import type { JiraVersion } from './types.js';

/** The versions an issue can be given: every one that is not archived, released or not. */
export function allowedVersions(versions: JiraVersion[]): JiraVersion[] {
  return versions.filter((v) => !v.archived);
}

/**
 * The project versions the names give, each once, in the order given. A fix version is always one
 * of the project's allowed versions: an unknown name is `not_found` and an archived one
 * `validation`, both listing the allowed names.
 */
export function resolveVersions(
  versions: JiraVersion[],
  names: string[],
  project: string
): JiraVersion[] {
  const found = new Map<string, JiraVersion>();
  const unknown: string[] = [];
  const archived: JiraVersion[] = [];
  for (const name of names) {
    const match = findByName(versions, name);
    if (!match) unknown.push(name.trim());
    else if (match.archived) archived.push(match);
    else found.set(match.id, match);
  }
  const allowed = `allowed: ${nameList(allowedVersions(versions))}`;
  const opts = {
    hint: `run \`lassi jira project version list ${project}\``,
    context: { product: 'jira' as const },
  };
  if (unknown.length > 0) {
    throw new LassiError(
      'not_found',
      `no version ${quoted(unknown)} in ${project}; ${allowed}`,
      opts
    );
  }
  if (archived.length > 0) {
    throw new LassiError(
      'validation',
      `version ${quoted(archived.map((v) => v.name))} in ${project} ${archived.length === 1 ? 'is' : 'are'} archived; ${allowed}`,
      opts
    );
  }
  return [...found.values()];
}

/**
 * The `PUT /issue/{key}` body: `set` replaces the fix versions with these, `add` keeps the ones the
 * issue has and adds these.
 */
export function fixVersionsUpdate(
  mode: 'set' | 'add',
  versions: Array<{ id: string }>
):
  | { fields: { fixVersions: Array<{ id: string }> } }
  | { update: { fixVersions: Array<{ add: { id: string } }> } } {
  const refs = versions.map((v) => ({ id: v.id }));
  return mode === 'set'
    ? { fields: { fixVersions: refs } }
    : { update: { fixVersions: refs.map((ref) => ({ add: ref })) } };
}
