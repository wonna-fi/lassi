import type { JiraAttachment, JiraComment, JiraIssueLink } from '../client/types.js';
import { wikiToMarkdown } from '../wiki/index.js';
import type { IssueCounts } from './frontmatter.js';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** `## Comments` section: author, date and id in the heading, the body converted to markdown. */
export function renderComments(comments: JiraComment[], heading = '## Comments'): string {
  if (comments.length === 0) return '';
  const parts = comments.map((c) => {
    const who = c.author?.name ?? 'unknown';
    const body = wikiToMarkdown(c.body).trimEnd();
    return `### ${who} · ${c.created} · id ${c.id}\n\n${body}\n`;
  });
  return `${heading}\n\n${parts.join('\n')}`;
}

export function renderAttachments(attachments: JiraAttachment[]): string {
  if (attachments.length === 0) return '';
  const rows = attachments.map(
    (a) => `| ${escapeCell(a.filename)} | ${humanSize(a.size)} | ${a.mimeType} | ${a.id} |`
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

export function renderLinks(issueKey: string, links: JiraIssueLink[]): string {
  if (links.length === 0) return '';
  const rows = links.map(
    (l) =>
      `| ${issueKey} ${l.description} ${l.otherKey} | ${l.otherKey} | ${escapeCell(l.otherSummary ?? '')} | ${l.otherStatus ?? ''} |`
  );
  return [
    '## Links',
    '',
    '| Link | Key | Summary | Status |',
    '| - | - | - | - |',
    ...rows,
    '',
  ].join('\n');
}

/** trailer, listing only what exists and was not expanded. */
export function trailerLine(
  counts: IssueCounts,
  expanded: { comments: boolean; attachments: boolean; links: boolean }
): string | undefined {
  const hidden: string[] = [];
  if (counts.comments > 0 && !expanded.comments)
    hidden.push(`${counts.comments} comment${counts.comments === 1 ? '' : 's'}`);
  if (counts.attachments > 0 && !expanded.attachments)
    hidden.push(`${counts.attachments} attachment${counts.attachments === 1 ? '' : 's'}`);
  if (counts.links > 0 && !expanded.links)
    hidden.push(`${counts.links} link${counts.links === 1 ? '' : 's'}`);
  if (hidden.length === 0) return undefined;
  return `(${hidden.join(', ')} not shown — use --comments, --attachments, --links or --all)`;
}

// Shared with the Confluence side; kept here so `@wonna/lassi-jira` keeps exporting them.
export {
  composeBody,
  expansionFromSections,
  joinSections,
  stripGeneratedSections,
} from '@wonna/lassi-core';
