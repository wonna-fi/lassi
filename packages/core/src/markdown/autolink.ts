import type { Root } from 'mdast';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';

/**
 * Applies GFM's autolink-literal transform (bare URLs, `www.` and e-mail addresses in text become
 * link nodes). `parseMarkdown` runs it implicitly; converters that build mdast from another
 * format call it so their output is canonical by construction.
 */
export function autolinkLiterals(tree: Root): Root {
  for (const transform of gfmAutolinkLiteralFromMarkdown().transforms ?? []) transform(tree);
  return tree;
}
