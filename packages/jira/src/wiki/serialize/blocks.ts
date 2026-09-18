import { LassiError, RAW_FENCE_LANGS } from '@wonna/lassi-core';
import type {
  Blockquote,
  Code,
  Definition,
  List,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { TASK } from '../syntax.js';
import { renderRun, type Container } from './inline.js';
import type { Warnings } from './warnings.js';

export interface BlockContext {
  warnings: Warnings;
  definitions: ReadonlyMap<string, Definition>;
}

const LANG = /^[A-Za-z0-9_+#.-]+$/;

function run(children: PhrasingContent[], container: Container, ctx: BlockContext): string {
  return renderRun(children, {
    container,
    closerMarkers: [],
    warnings: ctx.warnings,
    definitions: ctx.definitions,
  });
}

/** Flow content → wiki blocks (each a string without surrounding blank lines). */
export function renderBlocks(nodes: RootContent[], ctx: BlockContext): string[] {
  const out: string[] = [];
  for (const node of nodes) renderBlock(node, ctx, out);
  return out;
}

function renderBlock(node: RootContent, ctx: BlockContext, out: string[]): void {
  switch (node.type) {
    case 'heading': {
      const text = run(node.children, 'heading', ctx);
      if (text.trim() === '') ctx.warnings.add('empty-heading', 'empty heading', node);
      out.push(`h${node.depth}. ${text}`);
      return;
    }
    case 'paragraph':
      out.push(run(node.children, 'paragraph', ctx));
      return;
    case 'code':
      out.push(code(node, ctx));
      return;
    case 'thematicBreak':
      out.push('----');
      return;
    case 'blockquote':
      out.push(blockquote(node, ctx));
      return;
    case 'list': {
      const chunk: string[] = [];
      renderList(node, '', out, ctx, chunk);
      if (chunk.length > 0) out.push(chunk.join('\n'));
      return;
    }
    case 'table':
      out.push(table(node, ctx));
      return;
    case 'definition':
      return;
    case 'html':
      throw new LassiError(
        'validation',
        `HTML blocks are not supported in Jira wiki markup: ${node.value.slice(0, 40)}`,
        { hint: 'use markdown syntax or a ```jira fence' }
      );
    case 'footnoteDefinition':
      throw new LassiError('validation', 'footnotes are not supported in Jira wiki markup');
    default:
      throw new LassiError('validation', `unsupported markdown node: ${node.type}`);
  }
}

function code(node: Code, ctx: BlockContext): string {
  // A raw fence is exact wiki source: emitted verbatim, never escaped.
  if (node.lang === RAW_FENCE_LANGS.wiki) return node.value;
  if (node.meta) {
    ctx.warnings.add(
      'code-meta-dropped',
      `code block meta "${node.meta}" has no Jira wiki form`,
      node
    );
  }
  const { value } = node;
  if (node.lang === 'noformat') {
    if (value.includes('{noformat}')) {
      throw new LassiError('validation', 'a noformat block cannot contain {noformat}', {
        hint: 'split the block or use a ```jira fence',
      });
    }
    return `{noformat}\n${value}\n{noformat}`;
  }
  if (node.lang && !LANG.test(node.lang)) {
    throw new LassiError(
      'validation',
      `code block language "${node.lang}" is not valid in {code:…}`
    );
  }
  if (value.includes('{code}')) {
    if (value.includes('{noformat}')) {
      throw new LassiError('validation', 'a code block cannot contain both {code} and {noformat}', {
        hint: 'split the block or use a ```jira fence',
      });
    }
    ctx.warnings.add(
      'code-closer-in-body',
      'code block contains {code} and is written as {noformat}; the language is lost',
      node
    );
    return `{noformat}\n${value}\n{noformat}`;
  }
  return `${node.lang ? `{code:${node.lang}}` : '{code}'}\n${value}\n{code}`;
}

function unnest(children: RootContent[], ctx: BlockContext): RootContent[] {
  const out: RootContent[] = [];
  for (const child of children) {
    if (child.type === 'blockquote') {
      ctx.warnings.add('quote-flattened', 'nested quote flattened into its parent', child);
      out.push(...unnest(child.children, ctx));
    } else {
      out.push(child);
    }
  }
  return out;
}

/** One single-line paragraph → `bq.`; anything else → `{quote}` block. */
function blockquote(node: Blockquote, ctx: BlockContext): string {
  const children = unnest(node.children, ctx);
  const inner = renderBlocks(children, ctx);
  const single = inner.length === 1 ? (inner[0] as string) : undefined;
  if (children[0]?.type === 'paragraph' && single !== undefined && !single.includes('\n')) {
    return `bq. ${single}`;
  }
  const body = inner.join('\n\n');
  if (body.includes('{quote}')) {
    throw new LassiError('validation', 'a quote cannot contain {quote}', {
      hint: 'use a ```jira fence for the whole quote',
    });
  }
  return `{quote}\n${body}\n{quote}`;
}

/**
 * Marker runs by depth; a block child other than a nested list is hoisted after the list with a
 * warning, which splits the list into two wiki blocks.
 */
function renderList(
  list: List,
  prefix: string,
  out: string[],
  ctx: BlockContext,
  chunk: string[]
): void {
  const marker = list.ordered ? '#' : '*';
  if (list.ordered && list.start != null && list.start !== 1) {
    ctx.warnings.add(
      'list-start-dropped',
      `ordered list starting at ${list.start} restarts at 1 in Jira`,
      list
    );
  }
  for (const item of list.children) {
    const markers = prefix + marker;
    let rest = item.children;
    const first = rest[0];
    if (first?.type === 'paragraph') {
      const text = run(first.children, 'listItem', ctx);
      const task = item.checked === true ? '(/) ' : item.checked === false ? '(x) ' : '';
      if (task === '' && TASK.test(text)) {
        ctx.warnings.add(
          'task-marker-ambiguity',
          'list item text starts like a task marker and reads back as a task',
          item
        );
      }
      chunk.push(`${markers} ${task}${text}`);
      rest = rest.slice(1);
    } else if (rest.length === 0) {
      // An item with no content at all still occupies a row; dropping it would silently shorten
      // the list. The trailing space is what makes the marker read back as an empty item.
      chunk.push(`${markers} `);
    }
    for (const child of rest) {
      if (child.type === 'list') {
        renderList(child, markers, out, ctx, chunk);
        continue;
      }
      if (chunk.length > 0) {
        out.push(chunk.join('\n'));
        chunk.length = 0;
      }
      ctx.warnings.add(
        'list-split',
        `${child.type} inside a list item is written after the list; a numbered list restarts`,
        child
      );
      renderBlock(child, ctx, out);
    }
  }
}

function table(node: Table, ctx: BlockContext): string {
  const [header, ...rows] = node.children;
  if (!header) throw new LassiError('validation', 'a table needs a header row');
  const width = header.children.length;
  const cell = (c: TableCell): string => {
    const text = run(c.children, 'cell', ctx);
    return text.trim() === '' ? ' ' : text;
  };
  const lines = [`||${header.children.map(cell).join('||')}||`];
  for (const row of rows) {
    if (row.children.length > width) {
      throw new LassiError('validation', 'a table row is wider than its header row', {
        hint: 'cells may only contain inline content; keep every row within the header width',
      });
    }
    const cells = row.children.map(cell);
    while (cells.length < width) cells.push(' ');
    lines.push(`|${cells.join('|')}|`);
  }
  return lines.join('\n');
}
