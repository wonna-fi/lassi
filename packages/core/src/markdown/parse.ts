import type { Root } from 'mdast';
import { fromMarkdown, type Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import { mention, mentionFromMarkdown } from './mention.js';

export interface ParseMarkdownOptions {
  /** Additional micromark syntax extensions (e.g. Confluence `[[Page]]`). */
  extensions?: MicromarkExtension[];
  /** Matching mdast-util-from-markdown extensions. */
  mdastExtensions?: FromMarkdownExtension[];
}

/** GFM + `@mention` + product extensions → mdast. The one parser every converter uses. */
export function parseMarkdown(markdown: string, opts: ParseMarkdownOptions = {}): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm(), mention(), ...(opts.extensions ?? [])],
    mdastExtensions: [gfmFromMarkdown(), mentionFromMarkdown(), ...(opts.mdastExtensions ?? [])],
  });
}
