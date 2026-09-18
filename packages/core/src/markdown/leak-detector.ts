import type { Nodes, Root } from 'mdast';
import { visit } from 'unist-util-visit';
import type { Dialect } from './converter.js';

export interface LeakHit {
  dialect: Dialect;
  pattern: string;
  sample: string;
  line?: number;
}

/** signatures, plus `[~user]` (the most common leak from models that know Jira). */
const WIKI_SIGNATURES: ReadonlyArray<[string, RegExp]> = [
  ['heading h1.', /^h[1-6]\.\s/m],
  ['{code}', /\{code(?:[:}]|$)/m],
  ['{noformat}', /\{noformat\}/],
  ['{quote}', /\{quote\}/],
  ['{panel}', /\{panel(?:[:}])/],
  ['{color}', /\{color(?:[:}])/],
  ['[text|url]', /\[[^\]\n]+\|[^\]\n]+\]/],
  ['[~user]', /\[~[\w.@-]+\]/],
  ['||header||', /^\|\|/m],
  ['{{monospace}}', /\{\{[^}\n]+\}\}/],
];

const STORAGE_SIGNATURES: ReadonlyArray<[string, RegExp]> = [
  ['<ac:…>', /<ac:[a-z-]+/i],
  ['<ri:…>', /<ri:[a-z-]+/i],
];

function scan(value: string, line: number | undefined, out: LeakHit[]): void {
  for (const [pattern, re] of WIKI_SIGNATURES) {
    const m = re.exec(value);
    if (m)
      out.push({
        dialect: 'wiki',
        pattern,
        sample: m[0].slice(0, 60),
        ...(line === undefined ? {} : { line }),
      });
  }
  for (const [pattern, re] of STORAGE_SIGNATURES) {
    const m = re.exec(value);
    if (m)
      out.push({
        dialect: 'storage',
        pattern,
        sample: m[0].slice(0, 60),
        ...(line === undefined ? {} : { line }),
      });
  }
}

function plainText(node: Nodes): string {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'mention':
      return `@${node.username}`;
    case 'inlineCode':
    case 'code':
      return '';
    case 'break':
      return '\n';
    default:
      return 'children' in node ? node.children.map((c) => plainText(c as Nodes)).join('') : '';
  }
}

/**
 * Finds Atlassian markup in agent-written markdown, outside code, inline code and raw fences. Any
 * dialect counts as a leak regardless of the target: agents must write GFM. Blocks are
 * scanned as one string because a `[text|https://…]` leak is split around the autolink node.
 */
export function detectDialectLeak(tree: Root): LeakHit[] {
  const hits: LeakHit[] = [];
  visit(tree, (node) => {
    if (node.type === 'code' || node.type === 'inlineCode') return 'skip';
    if (node.type === 'html') {
      scan(node.value, node.position?.start.line, hits);
      return 'skip';
    }
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      scan(plainText(node), node.position?.start.line, hits);
      return 'skip';
    }
    return undefined;
  });
  return hits;
}

export function leakMessage(hits: LeakHit[]): string {
  const first = hits[0];
  const what = first?.dialect === 'storage' ? 'Confluence storage XHTML' : 'Jira wiki markup';
  const where = first?.line === undefined ? '' : ` (line ${first.line})`;
  return `input looks like ${what}${where}: found ${first?.pattern} in "${first?.sample}"; agents must write GFM — wrap intentional markup in a \`\`\`jira / \`\`\`confluence fence`;
}
