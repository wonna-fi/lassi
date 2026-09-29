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
  /** The issue the outward phrase describes: `sourceKey <type.outward> targetKey`. */
  sourceKey: string;
  targetKey: string;
  /** e.g. `PROJ-1 blocks PROJ-2`; printed by `--dry-run`. */
  sentence: string;
}

/**
 * The `POST /issueLink` body for `sourceKey <type.outward> targetKey`. Jira names the fields the other
 * way round from how they read: the source goes in `inwardIssue`, so `{ inwardIssue: A,
 * outwardIssue: B }` with type Blocks means "A blocks B" (Jira creates "a link from the first issue to
 * the second using the outward description"). Putting the source in `outwardIssue` stored every
 * link reversed. The issue view is the other way: there `outwardIssue` is the other end of an
 * outward link, which `normalizeLinks` reads.
 */
export function issueLinkRequest(
  typeName: string,
  sourceKey: string,
  targetKey: string
): { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } } {
  return {
    type: { name: typeName },
    inwardIssue: { key: sourceKey },
    outwardIssue: { key: targetKey },
  };
}

/**
 * Accepts the outward phrase ("blocks"), the type name ("Blocks") or the inward phrase
 * ("is blocked by", direction flipped), and says which issue the outward phrase describes.
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
    return { type, sourceKey: from, targetKey: to, sentence: `${from} ${type.outward} ${to}` };
  }
  return { type, sourceKey: to, targetKey: from, sentence: `${from} ${type.inward} ${to}` };
}

/**
 * The links on `from` that are `resolved`, as `link list from` shows them: the same type, the other
 * issue, and outward when `from` is the source. Jira refuses a duplicate, so one match is normal.
 */
export function findLinks(
  links: JiraIssueLink[],
  resolved: ResolvedLink,
  from: string
): JiraIssueLink[] {
  const other = resolved.sourceKey === from ? resolved.targetKey : resolved.sourceKey;
  const direction = resolved.sourceKey === from ? 'outward' : 'inward';
  // A type that reads the same both ways ("relates to") is listed the same from either end,
  // whichever way Jira stored it, so its stored direction must not decide the match.
  const symmetric = resolved.type.outward.toLowerCase() === resolved.type.inward.toLowerCase();
  return links.filter(
    (l) =>
      l.typeName === resolved.type.name &&
      l.otherKey === other &&
      (symmetric || l.direction === direction)
  );
}
