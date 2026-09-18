import { LassiError, detectDialectLeak, leakMessage, parseMarkdown } from '@wonna/lassi-core';
import { collectMentions, mdastToWiki, type JiraClient } from '@wonna/lassi-jira';
import type { Context } from '../../context.js';

/**
 * Markdown → wiki markup for every write. The leak detector refuses pasted markup (, exit
 * 2), mentions are validated as usernames (exit 5), and lossy-but-legal conversions are
 * reported on stderr. The mention lookups are reads, so they run under `--dry-run` too and the
 * preview is honest.
 */
export async function markdownBodyToWiki(
  ctx: Context,
  client: JiraClient,
  markdown: string
): Promise<string> {
  const tree = parseMarkdown(markdown);
  const hits = detectDialectLeak(tree);
  if (hits.length > 0) {
    throw new LassiError('usage', leakMessage(hits), {
      hint: 'agents write GitHub-flavoured Markdown; wrap intentional wiki markup in a ```jira fence',
      context: { product: 'jira' },
    });
  }
  const mentions = collectMentions(tree);
  if (mentions.length > 0) {
    const { unknown } = await client.validateMentions(mentions);
    if (unknown.length > 0) {
      throw new LassiError(
        'validation',
        `unknown user${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `@${u}`).join(', ')}`,
        {
          hint: 'mentions must be Jira usernames (the assignee/reporter values in issue files), not display names',
          context: { product: 'jira' },
        }
      );
    }
  }
  const { wiki, warnings } = mdastToWiki(tree);
  for (const warning of warnings) {
    ctx.logger.warn(
      `${warning.message}${warning.line === undefined ? '' : ` (line ${warning.line})`}`
    );
  }
  return wiki;
}
