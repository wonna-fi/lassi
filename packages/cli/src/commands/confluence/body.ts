import { LassiError, detectDialectLeak, leakMessage } from '@wonna/lassi-core';
import {
  collectMentions,
  createStorageConverter,
  mergeUserDirectories,
  parseConfluenceMarkdown,
  userDirectory,
  EMPTY_DIRECTORY,
  type ConfluenceClient,
  type StorageConverter,
  type StorageWriterOptions,
  type UserDirectory,
} from '@wonna/lassi-confluence';
import type { Context } from '../../context.js';

export interface StorageBodyOptions {
  /** The cached page's users (key ↔ username), so its mentions write back unchanged. */
  users?: UserDirectory;
  writer?: Partial<StorageWriterOptions>;
}

export interface StorageBody {
  storage: string;
  /** The directory the conversion used: page users plus every validated `@username`. */
  users: UserDirectory;
  converter: StorageConverter;
}

/**
 * Markdown → storage for every write. The leak detector refuses pasted XHTML,
 * `@username` mentions are validated and resolved to user keys (exit 5), and lossy-but-legal
 * conversions are reported on stderr. The lookups are reads, so they run under `--dry-run` too.
 */
export async function markdownBodyToStorage(
  ctx: Context,
  client: ConfluenceClient,
  markdown: string,
  opts: StorageBodyOptions = {}
): Promise<StorageBody> {
  const tree = parseConfluenceMarkdown(markdown);
  const hits = detectDialectLeak(tree);
  if (hits.length > 0) {
    throw new LassiError('usage', leakMessage(hits), {
      hint: 'agents write GitHub-flavoured Markdown; wrap intentional storage XHTML in a ```confluence fence',
      context: { product: 'confluence' },
    });
  }
  const mentions = collectMentions(tree);
  let validated: UserDirectory = EMPTY_DIRECTORY;
  if (mentions.usernames.length > 0) {
    const { known, unknown } = await client.validateMentions(mentions.usernames);
    if (unknown.length > 0) {
      throw new LassiError(
        'validation',
        `unknown user${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `@${u}`).join(', ')}`,
        {
          hint: 'mentions must be Confluence usernames, not display names; @{userkey:…} placeholders from a fetched page are kept as they are',
          context: { product: 'confluence' },
        }
      );
    }
    validated = userDirectory([...known].map(([username, userKey]) => ({ userKey, username })));
  }
  const users = mergeUserDirectories(opts.users ?? EMPTY_DIRECTORY, validated);
  const converter = createStorageConverter({
    users,
    ...(opts.writer ? { writer: opts.writer } : {}),
    onWriteWarning: (w) =>
      ctx.logger.warn(`${w.message}${w.line === undefined ? '' : ` (line ${w.line})`}`),
  });
  return { storage: converter.fromMdast(tree), users, converter };
}
