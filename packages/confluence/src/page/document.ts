import type {
  ChildKind,
  ConfluenceAttachment,
  ConfluenceComment,
  PageCounts,
} from '../client/types.js';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** `## Comments` section; bodies converted with the caller's converter (same users as the page). */
export function renderPageComments(
  comments: ConfluenceComment[],
  toMarkdown: (storage: string) => string
): string {
  if (comments.length === 0) return '';
  const parts = comments.map((c) => {
    const who = c.author?.username ?? 'unknown';
    const body = toMarkdown(c.storage).trimEnd();
    return `### ${who} · ${c.created ?? ''} · id ${c.id}\n\n${body}\n`;
  });
  return `## Comments\n\n${parts.join('\n')}`;
}

export function renderPageAttachments(attachments: ConfluenceAttachment[]): string {
  if (attachments.length === 0) return '';
  const rows = attachments.map(
    (a) => `| ${escapeCell(a.filename)} | ${humanSize(a.size)} | ${a.mediaType} | ${a.id} |`
  );
  return [
    '## Attachments',
    '',
    '| File | Size | MIME | Id |',
    '| - | - | - | - |',
    ...rows,
    '',
  ].join('\n');
}

/** Trailer listing what exists on the page and was not expanded. */
export function pageTrailer(
  counts: PageCounts,
  expanded: { comments: boolean; attachments: boolean }
): string | undefined {
  const hidden: string[] = [];
  const flags: string[] = [];
  // A capped walk gives a floor, not a total. Per kind: one capped count must not put a `+` on the
  // two beside it that were counted exactly.
  const at = (kind: ChildKind, n: number): string =>
    counts.truncated?.includes(kind) ? `${n}+` : `${n}`;
  if (counts.comments > 0 && !expanded.comments) {
    hidden.push(`${at('comments', counts.comments)} comment${counts.comments === 1 ? '' : 's'}`);
    flags.push('--comments');
  }
  if (counts.attachments > 0 && !expanded.attachments) {
    hidden.push(
      `${at('attachments', counts.attachments)} attachment${counts.attachments === 1 ? '' : 's'}`
    );
    flags.push('--attachments');
  }
  if (counts.children > 0) {
    hidden.push(`${at('children', counts.children)} child page${counts.children === 1 ? '' : 's'}`);
    flags.push('`lassi confluence tree <ID>`');
  }
  if (hidden.length === 0) return undefined;
  return `(${hidden.join(', ')} not shown — use ${flags.join(', ')})`;
}
