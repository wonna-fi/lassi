import {
  brief as briefText,
  escapeRegExp,
  parseAtlassianDate,
  type Since,
} from '@wonna/lassi-core';
import { flattenChangelog, type ChangeRow } from '../changelog/flatten.js';
import type { JiraComment, JiraHistory, JiraIssue, JiraSearchPage } from '../client/types.js';
import { wikiToMarkdown } from '../wiki/index.js';

export interface DigestComment {
  id: string;
  who: string;
  at: string;
  /** Markdown, one paragraph, cut at `SNIPPET_CHARS`. */
  body: string;
}

export interface DigestMention extends DigestComment {
  key: string;
  summary: string;
}

export interface DigestIssue {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  updated?: string;
  /** Events by other people only; the user's own are under `actions`. */
  changes: ChangeRow[];
  comments: DigestComment[];
  /** Jira cut this issue's changelog, so `changes` may be missing entries. */
  partial: boolean;
}

export interface DigestAction {
  key: string;
  summary: string;
  at: string;
  what: string;
}

export interface Digest {
  me: string;
  /** ISO instant of the window start. */
  since: string;
  sinceText: string;
  jql?: string;
  mentions: DigestMention[];
  changed: DigestIssue[];
  actions: DigestAction[];
  totals: { mentions: number; changed: number; actions: number };
  /** A section's search had more issues than were fetched. */
  truncated: { mine: boolean; mentions: boolean };
}

export interface BuildDigestInput {
  me: string;
  since: Since;
  aliases?: Record<string, string>;
  mine: JiraSearchPage;
  mentions: JiraSearchPage;
  jql?: string;
}

export const SNIPPET_CHARS = 300;
/** A changed value (a whole description, say) is shown as one short line, like a comment. */
export const VALUE_CHARS = 120;

const brief = (value: string, max = VALUE_CHARS): string => briefText(value, max);

const briefRow = (row: ChangeRow): ChangeRow => ({
  ...row,
  from: brief(row.from),
  to: brief(row.to),
});

/** Exact `[~name]` in wiki markup; `[~jsmithson]` is not a mention of `jsmith`. */
export function mentionsUser(wikiBody: string, me: string): boolean {
  return new RegExp(`\\[~${escapeRegExp(me)}\\]`).test(wikiBody);
}

/** The first paragraph of a comment as one line of markdown, cut with an ellipsis. */
export function commentSnippet(wikiBody: string, max = SNIPPET_CHARS): string {
  const markdown = wikiToMarkdown(wikiBody).trim();
  return brief(markdown.split(/\n\s*\n/)[0] ?? '', max);
}

function inWindow(created: string, since: Since): boolean {
  const at = parseAtlassianDate(created);
  return at === undefined || at.getTime() >= since.instant.getTime();
}

function comments(issue: JiraIssue): JiraComment[] {
  return issue.fields.comment?.comments ?? [];
}

function who(comment: JiraComment): string {
  return comment.author?.name ?? comment.author?.displayName ?? 'unknown';
}

const byAt = <T extends { at: string }>(a: T, b: T): number =>
  (parseAtlassianDate(a.at)?.getTime() ?? 0) - (parseAtlassianDate(b.at)?.getTime() ?? 0);

/** Pure: two search pages in, the three digest sections out. Reusable without the CLI. */
export function buildDigest(input: BuildDigestInput): Digest {
  const { me, since } = input;
  const aliases = input.aliases ?? {};
  const options = { since: since.instant, aliases };

  const mentions: DigestMention[] = [];
  for (const issue of input.mentions.issues) {
    for (const c of comments(issue)) {
      if (who(c) === me || !inWindow(c.created, since) || !mentionsUser(c.body, me)) continue;
      mentions.push({
        key: issue.key,
        summary: issue.fields.summary ?? '',
        id: c.id,
        who: who(c),
        at: c.created,
        body: commentSnippet(c.body),
      });
    }
  }

  const changed: DigestIssue[] = [];
  const actions: DigestAction[] = [];
  for (const issue of input.mine.issues) {
    const summary = issue.fields.summary ?? '';
    const log = issue.changelog;
    const partial = log !== undefined && log.total > log.histories.length;
    const histories = log?.histories ?? [];
    const others: JiraHistory[] = [];
    const mine: JiraHistory[] = [];
    for (const h of histories) ((h.author?.name ?? '') === me ? mine : others).push(h);
    const changes = flattenChangelog(others, options).map(briefRow);
    const theirComments: DigestComment[] = [];
    for (const c of comments(issue)) {
      if (!inWindow(c.created, since)) continue;
      const entry = { id: c.id, who: who(c), at: c.created, body: commentSnippet(c.body) };
      if (who(c) === me) {
        actions.push({
          key: issue.key,
          summary,
          at: c.created,
          what: `commented: "${entry.body}"`,
        });
      } else theirComments.push(entry);
    }
    // One action per history. Grouping the flattened rows by timestamp instead would merge two
    // distinct histories that share a `created` into one action, combining unrelated changes and
    // undercounting the total; a history is the unit the user actually performed.
    for (const h of mine) {
      if (!inWindow(h.created, since)) continue;
      const rows = flattenChangelog([h], options).map(briefRow);
      if (rows.length === 0) continue;
      actions.push({
        key: issue.key,
        summary,
        at: h.created,
        what: rows.map((r) => `${r.field}: ${r.from || '-'} → ${r.to || '-'}`).join(', '),
      });
    }
    if (changes.length > 0 || theirComments.length > 0 || partial) {
      changed.push({
        key: issue.key,
        summary,
        status: issue.fields.status?.name ?? '',
        ...(issue.fields.assignee?.name ? { assignee: issue.fields.assignee.name } : {}),
        ...(issue.fields.updated ? { updated: issue.fields.updated } : {}),
        changes,
        comments: theirComments.sort(byAt),
        partial,
      });
    }
  }
  mentions.sort(byAt);
  actions.sort(byAt);

  return {
    me,
    since: since.instant.toISOString(),
    sinceText: since.text,
    ...(input.jql === undefined ? {} : { jql: input.jql }),
    mentions,
    changed,
    actions,
    totals: { mentions: mentions.length, changed: changed.length, actions: actions.length },
    truncated: {
      mine: input.mine.total > input.mine.issues.length,
      mentions: input.mentions.total > input.mentions.issues.length,
    },
  };
}
