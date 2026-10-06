import { LassiError, detectDialectLeak, leakMessage, parseMarkdown } from '@wonna/lassi-core';
import {
  collectMentions,
  formatOf,
  mdastToWiki,
  type FieldPolicy,
  type JiraClient,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';

/**
 * Whether a `--field` value is Markdown to convert like a body: the field is configured
 * `format: "wiki"`, and the value is not one of the clears (`-` or empty, as for any field). Not
 * the JSON escape hatch either: a value starting with `[` is a link here.
 */
export function takesMarkdown(policy: FieldPolicy, id: string, raw: string): boolean {
  const trimmed = raw.trim();
  return formatOf(policy, id) === 'wiki' && trimmed !== '' && trimmed !== '-';
}

/**
 * Markdown → wiki markup for every write. The leak detector refuses pasted markup (, exit
 * 2), mentions are validated as usernames (exit 5), and lossy-but-legal conversions are
 * reported on stderr. The mention lookups are reads, so they run under `--dry-run` too and the
 * preview is honest.
 */
export async function markdownBodyToWiki(
  ctx: Context,
  client: JiraClient,
  markdown: string,
  opts: { field?: string } = {}
): Promise<string> {
  // A field value's line numbers count from its own first line, so say which value they are in.
  const prefix = opts.field === undefined ? '' : `${opts.field}: `;
  const tree = parseMarkdown(markdown);
  const hits = detectDialectLeak(tree);
  if (hits.length > 0) {
    throw new LassiError('usage', `${prefix}${leakMessage(hits)}`, {
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
        `${prefix}unknown user${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `@${u}`).join(', ')}`,
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
      `${prefix}${warning.message}${warning.line === undefined ? '' : ` (line ${warning.line})`}`
    );
  }
  return wiki;
}
