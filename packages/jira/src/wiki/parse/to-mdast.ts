import { autolinkLiterals, rawFence } from '@wonna/lassi-core';
import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from 'mdast';
import { TASK } from '../syntax.js';
import { tokenizeBlocks, type BlockToken, type ListItemToken } from './blocks.js';
import { breakSafeRun, parseInline } from './inline.js';

type Flow = BlockContent | DefinitionContent;

function paragraphOf(
  text: string,
  opts: { inTableCell?: boolean } = {}
): { node: Paragraph; unsupported: string[] } {
  const { nodes, unsupported } = parseInline(text, opts);
  return { node: { type: 'paragraph', children: breakSafeRun(nodes) }, unsupported };
}

/** An ATX heading has no hard-break form in markdown; Jira's `\\` inside `h1.` becomes a space. */
function withoutBreaks(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    const value = node.type === 'break' ? ' ' : undefined;
    const last = out[out.length - 1];
    if (value !== undefined) {
      if (last?.type === 'text') last.value += value;
      else out.push({ type: 'text', value });
    } else if (node.type === 'text' && last?.type === 'text') {
      last.value += node.value;
    } else {
      out.push(node);
    }
  }
  return out;
}

function listItem(item: ListItemToken): { node: ListItem; unsupported: string[] } {
  let text = item.text;
  let checked: boolean | undefined;
  const task = TASK.exec(text);
  if (task) {
    checked = task[1] === '/';
    text = text.slice(task[0].length);
  }
  const { node, unsupported } = paragraphOf(text);
  const li: ListItem = { type: 'listItem', spread: false, children: [node] };
  if (checked !== undefined) li.checked = checked;
  return { node: li, unsupported };
}

/** Builds nested lists from marker runs (`*`, `**`, `*#`); a level skip synthesises an empty item. */
function buildLists(items: ListItemToken[]): { lists: List[]; unsupported: string[] } {
  const lists: List[] = [];
  const unsupported: string[] = [];
  const stack: Array<{ list: List; depth: number }> = [];
  for (const item of items) {
    const depth = item.markers.length;
    const ordered = item.markers[depth - 1] === '#';
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { list: List; depth: number };
      if (top.depth > depth || (top.depth === depth && top.list.ordered !== ordered)) stack.pop();
      else break;
    }
    while ((stack[stack.length - 1]?.depth ?? 0) < depth) {
      const parent = stack[stack.length - 1];
      const newDepth = (parent?.depth ?? 0) + 1;
      const list: List = {
        type: 'list',
        ordered: newDepth === depth ? ordered : item.markers[newDepth - 1] === '#',
        spread: false,
        children: [],
      };
      if (!parent) {
        lists.push(list);
      } else {
        let last = parent.list.children[parent.list.children.length - 1];
        if (!last) {
          last = { type: 'listItem', spread: false, children: [] };
          parent.list.children.push(last);
        }
        last.children.push(list);
      }
      stack.push({ list, depth: newDepth });
    }
    const target = (stack[stack.length - 1] as { list: List }).list;
    const built = listItem(item);
    unsupported.push(...built.unsupported);
    target.children.push(built.node);
  }
  return { lists, unsupported };
}

function tableOf(token: Extract<BlockToken, { type: 'table' }>): Flow {
  const rows: TableRow[] = [];
  for (const row of token.rows) {
    const cells = [];
    for (const cell of row.cells) {
      const { nodes, unsupported } = parseInline(cell, { inTableCell: true });
      if (unsupported.length > 0) return rawFence('wiki', token.source.join('\n'));
      cells.push({ type: 'tableCell' as const, children: nodes });
    }
    rows.push({ type: 'tableRow', children: cells });
  }
  const table: Table = {
    type: 'table',
    align: token.rows[0]?.cells.map(() => null) ?? [],
    children: rows,
  };
  return table;
}

function convert(tokens: BlockToken[]): Flow[] {
  const out: Flow[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const { nodes, unsupported } = parseInline(token.text);
        out.push(
          unsupported.length > 0
            ? rawFence('wiki', token.source)
            : {
                type: 'heading',
                depth: token.depth as 1 | 2 | 3 | 4 | 5 | 6,
                children: withoutBreaks(nodes),
              }
        );
        break;
      }
      case 'paragraph': {
        const { node, unsupported } = paragraphOf(token.lines.join('\n'));
        out.push(unsupported.length > 0 ? rawFence('wiki', token.lines.join('\n')) : node);
        break;
      }
      case 'bq': {
        const { node, unsupported } = paragraphOf(token.lines.join('\n'));
        out.push(
          unsupported.length > 0
            ? rawFence('wiki', `bq. ${token.lines.join('\n')}`)
            : { type: 'blockquote', children: [node] }
        );
        break;
      }
      case 'quote':
        out.push({ type: 'blockquote', children: convert(token.body) });
        break;
      case 'code':
        out.push({ type: 'code', lang: token.lang ?? null, value: token.value });
        break;
      case 'raw':
        out.push(rawFence('wiki', token.lines.join('\n')));
        break;
      case 'rule':
        out.push({ type: 'thematicBreak' });
        break;
      case 'table':
        out.push(tableOf(token));
        break;
      case 'list': {
        const { lists, unsupported } = buildLists(token.items);
        if (unsupported.length > 0) out.push(rawFence('wiki', token.source.join('\n')));
        else out.push(...lists);
        break;
      }
    }
  }
  return out;
}

/** Jira wiki markup → mdast. Tolerant: whatever is not understood is kept verbatim in a raw fence. */
export function wikiToMdast(wiki: string): Root {
  const lines = wiki.replace(/\r\n?/g, '\n').split('\n');
  const children = convert(tokenizeBlocks(lines)) as RootContent[];
  return autolinkLiterals({ type: 'root', children });
}
