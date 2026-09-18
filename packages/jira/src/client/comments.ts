import { LassiError } from '@wonna/lassi-core';
import type { JiraComment, JiraCommentPage } from './types.js';

export interface CommentRead extends JiraCommentPage {
  requested: number | 'all';
  /** The requested selection could not be obtained, rather than an intentional newest-N limit. */
  incomplete: boolean;
}

export type CommentPageReader = (opts: {
  startAt: number;
  limit: number;
  newest: boolean;
}) => Promise<JiraCommentPage>;
const COMMENT_CAP = 5000;

/** Page by the actual returned count; Jira may impose a smaller page size than requested. */
export async function readComments(
  read: CommentPageReader,
  requested: number | 'all'
): Promise<CommentRead> {
  if (requested !== 'all' && (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new LassiError('usage', 'comment limit must be a positive whole number');
  }
  const cap = requested === 'all' ? COMMENT_CAP : Math.min(COMMENT_CAP, requested);
  const comments = new Map<string, JiraComment>();
  let startAt = 0;
  let total: number | undefined;
  let changed = false;
  for (;;) {
    const page = await read({
      startAt,
      limit: Math.min(100, cap - comments.size),
      newest: requested !== 'all',
    });
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.startAt !== startAt) {
      throw new LassiError('validation', 'Jira returned inconsistent comment pagination', {
        hint: 'retry the read; if it persists, check the Jira comment endpoint with lassi doctor',
      });
    }
    if (total !== undefined && page.total !== total) changed = true;
    total = Math.max(total ?? 0, page.total);
    const before = comments.size;
    const selected =
      requested === 'all' ? page.comments : page.comments.slice(-(cap - comments.size));
    for (const comment of selected) {
      if (comments.size >= cap) break;
      comments.set(comment.id, comment);
    }
    startAt += page.comments.length;
    const target = Math.min(total, cap);
    if (
      comments.size >= target ||
      startAt >= total ||
      comments.size === before ||
      startAt >= COMMENT_CAP
    )
      break;
  }
  const all = [...comments.values()].sort(
    (a, b) =>
      Date.parse(a.created) - Date.parse(b.created) ||
      a.id.localeCompare(b.id, 'en', { numeric: true })
  );
  const wanted = requested === 'all' ? (total ?? 0) : Math.min(requested, total ?? 0);
  return {
    comments: all,
    total: total ?? 0,
    startAt: requested === 'all' ? 0 : Math.max(0, (total ?? 0) - all.length),
    maxResults: all.length,
    requested,
    incomplete: changed || all.length < wanted,
  };
}
