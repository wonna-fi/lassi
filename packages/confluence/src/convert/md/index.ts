import {
  normalizeMarkdown,
  parseMarkdown,
  stringifyMarkdown,
  type ParseMarkdownOptions,
  type StringifyMarkdownOptions,
} from '@wonna/lassi-core';
import type { Root } from 'mdast';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { alertFromMarkdown, alertMarker, alertToMarkdown } from './alert.js';
import { jiraMacro, jiraMacroFromMarkdown, jiraMacroToMarkdown } from './jiramacro.js';
import { pageLink, pageLinkFromMarkdown, pageLinkToMarkdown } from './pagelink.js';
import { userKeyMention, userKeyMentionFromMarkdown, userKeyMentionToMarkdown } from './userkey.js';

export type { Alert, AlertKind, AlertMarker } from './alert.js';
export type { JiraMacro } from './jiramacro.js';
export type { PageLink } from './pagelink.js';
export { parsePageLinkBody } from './pagelink.js';

/** The Confluence markdown dialect on top of core's GFM + `@name`. */
export const CONFLUENCE_PARSE_OPTIONS: ParseMarkdownOptions = {
  extensions: [pageLink(), jiraMacro(), alertMarker(), userKeyMention()],
  mdastExtensions: [
    pageLinkFromMarkdown(),
    jiraMacroFromMarkdown(),
    alertFromMarkdown(),
    userKeyMentionFromMarkdown(),
  ],
};

export function confluenceToMarkdown(): ToMarkdownExtension[] {
  return [
    pageLinkToMarkdown(),
    jiraMacroToMarkdown(),
    alertToMarkdown(),
    userKeyMentionToMarkdown(),
  ];
}

export const CONFLUENCE_STRINGIFY_OPTIONS: StringifyMarkdownOptions = {
  extensions: confluenceToMarkdown(),
};

export function parseConfluenceMarkdown(markdown: string): Root {
  return parseMarkdown(markdown, CONFLUENCE_PARSE_OPTIONS);
}

export function stringifyConfluenceMarkdown(tree: Root): string {
  return stringifyMarkdown(tree, CONFLUENCE_STRINGIFY_OPTIONS);
}

/** Canonical form for the Confluence dialect; fixture `markdown.md` files are fixed points of it. */
export function normalizeConfluenceMarkdown(markdown: string): string {
  return normalizeMarkdown(markdown, {
    parse: CONFLUENCE_PARSE_OPTIONS,
    stringify: CONFLUENCE_STRINGIFY_OPTIONS,
  });
}
