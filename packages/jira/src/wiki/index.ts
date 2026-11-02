import { stringifyMarkdown, type BodyConverter } from '@wonna/lassi-core';
import { wikiToMdast } from './parse/to-mdast.js';
import { markdownToWiki, type WikiSerializeOptions, type WikiWarning } from './serialize/index.js';

export { wikiToMdast } from './parse/to-mdast.js';
export { parseInline } from './parse/inline.js';
export { startsBlock, tokenizeBlocks } from './parse/blocks.js';
export {
  collectMentions,
  markdownToWiki,
  mdastToWiki,
  type WikiSerializeOptions,
  type WikiSerializeResult,
  type WikiWarning,
  type WikiWarningCode,
} from './serialize/index.js';
export { escapeWikiText, type EscapeContext } from './serialize/escape.js';

/** Jira wiki markup → canonical GitHub-flavoured Markdown (read direction, ). */
export function wikiToMarkdown(wiki: string): string {
  return stringifyMarkdown(wikiToMdast(wiki));
}

/** Both directions behind core's `BodyConverter`; warnings go to `onWarning` (default: dropped). */
export function createWikiConverter(
  opts: WikiSerializeOptions & { onWarning?: (warning: WikiWarning) => void } = {}
): BodyConverter {
  return {
    format: 'wiki',
    toMarkdown: wikiToMarkdown,
    fromMarkdown(markdown) {
      const result = markdownToWiki(markdown, opts);
      for (const warning of result.warnings) opts.onWarning?.(warning);
      return result.wiki;
    },
  };
}
