import { LassiError } from '@wonna/lassi-core';
import type { JiraIssueLink, JiraLinkType, JiraRawIssueLink } from './types.js';

export function normalizeLinks(raw: JiraRawIssueLink[] | undefined): JiraIssueLink[] {
  const out: JiraIssueLink[] = [];
  for (const link of raw ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other) continue;
    const direction = link.outwardIssue ? 'outward' : 'inward';
    const item: JiraIssueLink = {
      id: link.id,
      typeName: link.type.name,
      direction,
      description: direction === 'outward' ? link.type.outward : link.type.inward,
      otherKey: other.key,
    };
    if (other.fields?.summary !== undefined) item.otherSummary = other.fields.summary;
    if (other.fields?.status?.name !== undefined) item.otherStatus = other.fields.status.name;
    out.push(item);
  }
  return out;
}

export interface ResolvedLink {
  type: JiraLinkType;
  outwardKey: string;
  inwardKey: string;
  /** e.g. `PROJ-1 blocks PROJ-2`; printed by `--dry-run`. */
  sentence: string;
}

/**
 * Accepts the outward phrase ("blocks"), the type name ("Blocks") or the inward phrase
 * ("is blocked by", direction flipped). Jira semantics: `{ outwardIssue: A, inwardIssue: B }` with
 * type Blocks means "A blocks B".
 */
export function resolveLinkDirection(
  types: JiraLinkType[],
  phrase: string,
  from: string,
  to: string
): ResolvedLink {
  const wanted = phrase.trim().toLowerCase();
  const outwardMatches = types.filter(
    (t) => t.outward.toLowerCase() === wanted || t.name.toLowerCase() === wanted
  );
  const inwardMatches = types.filter((t) => t.inward.toLowerCase() === wanted);
  const distinct = new Map<string, JiraLinkType>();
  for (const t of [...outwardMatches, ...inwardMatches]) distinct.set(t.id, t);
  if (distinct.size === 0) {
    throw new LassiError('not_found', `no link type matches "${phrase}"`, {
      hint: 'run `lassi jira link types` to see the outward and inward names',
      context: { product: 'jira', operation: 'link' },
    });
  }
  if (distinct.size > 1) {
    const list = [...distinct.values()]
      .map((t) => `${t.name} (${t.outward} / ${t.inward})`)
      .join(', ');
    throw new LassiError('validation', `"${phrase}" matches several link types: ${list}`, {
      hint: 'use the exact outward or inward phrase',
      context: { product: 'jira', operation: 'link' },
    });
  }
  const type = [...distinct.values()][0] as JiraLinkType;
  if (outwardMatches.length > 0) {
    return { type, outwardKey: from, inwardKey: to, sentence: `${from} ${type.outward} ${to}` };
  }
  return { type, outwardKey: to, inwardKey: from, sentence: `${from} ${type.inward} ${to}` };
}
