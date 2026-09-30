import { LassiError } from '@wonna/lassi-core';
import { findByName, nameList, quoted } from './named.js';
import type { JiraComponent, JiraNamed } from './types.js';

/** Jira's update verbs take a component by id, or by name for one that does not exist yet. */
export type ComponentRef = { id: string } | { name: string };

export function componentRef(c: { id?: string; name: string }): ComponentRef {
  return c.id === undefined ? { name: c.name } : { id: c.id };
}

/** The `POST /component` body; the dry run prints the same one. */
export function componentCreateRequest(req: {
  project: string;
  name: string;
  description?: string;
}): { name: string; project: string; description?: string } {
  return {
    name: req.name,
    project: req.project,
    ...(req.description === undefined ? {} : { description: req.description }),
  };
}

/**
 * The `PUT /issue/{key}` body that adds or removes these components and leaves the others. A
 * `fields.components` list would replace every component the issue has.
 */
export function componentUpdate(
  op: 'add' | 'remove',
  refs: ComponentRef[]
): { update: { components: Array<{ add: ComponentRef } | { remove: ComponentRef }> } } {
  return {
    update: {
      components: refs.map((ref) => (op === 'add' ? { add: ref } : { remove: ref })),
    },
  };
}

export interface ComponentAddPlan {
  /** Project components the issue does not have yet. */
  add: JiraComponent[];
  /** Names the project does not have: created first, with `--create`. */
  create: string[];
  /** Names the issue already has, as Jira spells them. */
  unchanged: string[];
}

/**
 * Sorts the names given to `issue component add` before anything is sent, so a typo in the last name
 * does not leave the first ones added. A name the project lacks is refused unless `create` is set,
 * and an archived component is refused either way.
 */
export function planComponentAdd(
  names: string[],
  opts: {
    project: string;
    projectComponents: JiraComponent[];
    issueComponents: JiraNamed[];
    create: boolean;
  }
): ComponentAddPlan {
  const plan: ComponentAddPlan = { add: [], create: [], unchanged: [] };
  const archived: JiraComponent[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const onIssue = findByName(opts.issueComponents, name);
    if (onIssue) {
      if (!seen.has(onIssue.name.toLowerCase())) plan.unchanged.push(onIssue.name);
      seen.add(onIssue.name.toLowerCase());
      continue;
    }
    const known = findByName(opts.projectComponents, name);
    const label = (known?.name ?? name.trim()).toLowerCase();
    if (seen.has(label)) continue;
    seen.add(label);
    if (known?.archived) archived.push(known);
    else if (known) plan.add.push(known);
    else plan.create.push(name.trim());
  }
  const context = { product: 'jira' as const };
  if (plan.create.length > 0 && !opts.create) {
    const s = plan.create.length === 1 ? '' : 's';
    throw new LassiError(
      'not_found',
      `no component${s} ${quoted(plan.create)} in ${opts.project}; components: ${nameList(opts.projectComponents.filter((c) => !c.archived))}`,
      {
        hint: `pass --create to create ${s ? 'them' : 'it'}, or run \`lassi jira component list ${opts.project}\``,
        context,
      }
    );
  }
  if (archived.length > 0) {
    throw new LassiError(
      'validation',
      `component${archived.length === 1 ? '' : 's'} ${quoted(archived.map((c) => c.name))} in ${opts.project} ${archived.length === 1 ? 'is' : 'are'} archived`,
      { hint: 'unarchive it in the project settings, or pick another component', context }
    );
  }
  return plan;
}

/** The issue's components that `issue component remove` names; every name must be one of them. */
export function planComponentRemove(
  names: string[],
  opts: { issueKey: string; issueComponents: JiraNamed[] }
): JiraNamed[] {
  const found = new Map<string, JiraNamed>();
  const missing: string[] = [];
  for (const name of names) {
    const match = findByName(opts.issueComponents, name);
    if (match) found.set(match.name.toLowerCase(), match);
    else missing.push(name.trim());
  }
  if (missing.length > 0) {
    // A typo must not look like a successful removal, so a name the issue lacks is an error.
    throw new LassiError(
      'not_found',
      `${opts.issueKey} has no component ${quoted(missing)}; its components: ${nameList(opts.issueComponents)}`,
      { context: { product: 'jira' } }
    );
  }
  return [...found.values()];
}
