import { LassiError, quoteLiteral, type Since } from '@wonna/lassi-core';
import { sinceToJql } from '../changelog/flatten.js';

export interface DigestJqlOptions {
  /** Appended to every section as `AND (<extra>)`. */
  extra?: string;
}

export interface DigestJql {
  /** Issues the user is assigned to, reported or watches, updated in the window. */
  mine: string;
  /** Issues whose comments mention the user's name (Lucene tokenises `[~jsmith]` to `jsmith`). */
  mentions: string;
}

/** A JQL string literal, so a username can never break the clause. */
export const jqlQuote = quoteLiteral;

/** A `--jql` clause the digest can wrap in `AND (…)`; usage error otherwise, before any request. */
export function assertDigestClause(extra: string | undefined): string | undefined {
  const clause = extra?.trim();
  if (!clause) return undefined;
  // `text ~ "order by"` is a search, not an ordering: look outside string literals only.
  const unquoted = clause.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  if (/\border\s+by\b/i.test(unquoted)) {
    throw new LassiError(
      'usage',
      '--jql must not contain ORDER BY; the digest orders each section itself'
    );
  }
  // The clause is wrapped in `AND (…)`, so unbalanced parentheses close that wrapper and the rest
  // of the section's own conditions stop applying: `project = DEV) OR (priority = Blocker` returned
  // every Blocker regardless of assignee or window.
  let depth = 0;
  for (const ch of unquoted) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth < 0) break;
  }
  if (depth !== 0) {
    throw new LassiError(
      'usage',
      '--jql has unbalanced parentheses; the digest wraps the clause in AND (…), so it must close everything it opens'
    );
  }
  return clause;
}

export function digestJql(
  me: string,
  since: Since,
  now: Date,
  opts: DigestJqlOptions = {}
): DigestJql {
  const extra = assertDigestClause(opts.extra);
  const window = `updated >= ${sinceToJql(since, now)}`;
  const and = extra ? ` AND (${extra})` : '';
  return {
    mine: `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND ${window}${and} ORDER BY updated DESC`,
    mentions: `comment ~ ${jqlQuote(me)} AND ${window}${and} ORDER BY updated DESC`,
  };
}
