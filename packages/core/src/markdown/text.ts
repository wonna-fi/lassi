import type { Node } from 'mdast';
import { toString } from 'mdast-util-to-string';

/**
 * A node's text with its markup removed. Slicing the source and stripping `#` only works for ATX
 * headings: a setext heading keeps its underline and a closing-hash heading keeps its trailing
 * hashes, and either would be stored, embedded and shown.
 */
export function plainText(node: Node): string {
  return toString(node).trim();
}
