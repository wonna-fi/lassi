import { parseMarkdown, type Mention } from '@wonna/lassi-core';
import type { Definition, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { renderBlocks } from './blocks.js';
import { Warnings, type WikiWarning } from './warnings.js';

export type { WikiWarning, WikiWarningCode } from './warnings.js';

export interface WikiSerializeResult {
  wiki: string;
  warnings: WikiWarning[];
}

/** mdast → Jira wiki markup (write direction). Unrepresentable input throws. */
export function mdastToWiki(tree: Root): WikiSerializeResult {
  const warnings = new Warnings();
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', (node) => {
    definitions.set(node.identifier, node);
  });
  const blocks = renderBlocks(tree.children, { warnings, definitions });
  return { wiki: blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`, warnings: warnings.list };
}

/** Markdown body (frontmatter already removed) → Jira wiki markup. */
export function markdownToWiki(markdown: string): WikiSerializeResult {
  return mdastToWiki(parseMarkdown(markdown));
}

/** Unique `@username` mentions in document order, for `validateMentions` before a write. */
export function collectMentions(tree: Root): string[] {
  const seen = new Set<string>();
  visit(tree, 'mention', (node) => {
    seen.add((node as Mention).username);
  });
  return [...seen];
}
