import { autolinkLiterals, rawFence, type Mention } from '@wonna/lassi-core';
import { visit } from 'unist-util-visit';
import type { ChildNode, Element } from 'domhandler';
import { isCDATA, isComment, isDirective, isTag, isText } from 'domhandler';
import type {
  BlockContent,
  Code,
  Link,
  DefinitionContent,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  TableRow,
} from 'mdast';
import type { JiraMacro } from './md/jiramacro.js';
import type { PageLink } from './md/pagelink.js';
import { readMacro, macroParams } from './macros-read.js';
import { BLOCK_ELEMENTS, VERBATIM } from './normalize.js';
import { encodeParams } from './params.js';
import { EMPTY_DIRECTORY, type UserDirectory } from './users.js';
import type { ConverterWarning, ConverterWarningCode } from './warnings.js';
import {
  attributesOf,
  decodeAttr,
  decodeText,
  parseStorage,
  sliceRange,
  sliceSource,
} from './xml/parse.js';

export type Flow = BlockContent | DefinitionContent;

export interface ReadOptions {
  users?: UserDirectory;
}

/** `view` reads the rendered HTML (`--format view`); its fences are plain `html` code blocks. */
export type ReadMode = 'storage' | 'view';

export interface ReadResult {
  tree: Root;
  warnings: ConverterWarning[];
  /** Table shapes and mention forms seen, for `inferWriterOptions`. */
  shapes: PageShapes;
}

export interface PageShapes {
  tableShells: Array<'plain' | 'wrapped' | 'wrapped-colgroup'>;
  cellWraps: Array<'none' | 'p'>;
  mentionAttributes: Array<'userkey' | 'username'>;
  /** Whether task bodies carry the editor's placeholder span. */
  taskBodies: Array<'span' | 'bare'>;
  /** Whether a URL that is its own label is an anchor or plain text; markdown cannot tell them apart. */
  autolinks: Array<'anchor' | 'text'>;
}

/** Everything the walk needs; `path` is the positional XPath of the current parent. */
export interface ReadContext {
  src: string;
  users: UserDirectory;
  warnings: ConverterWarning[];
  shapes: PageShapes;
  path: string;
  inCell: boolean;
  mode: ReadMode;
  /** Inside `li`: a keyed jira macro among inline siblings is inline content, not a block. */
  inListItem: boolean;
}

export function createReadContext(src: string, users: UserDirectory, mode: ReadMode): ReadContext {
  return {
    src,
    users,
    warnings: [],
    shapes: {
      tableShells: [],
      cellWraps: [],
      mentionAttributes: [],
      taskBodies: [],
      autolinks: [],
    },
    path: '',
    inCell: false,
    mode,
    inListItem: false,
  };
}

export const HEADINGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const IMAGE_PARAM_VALUE = /^[^\s"]+$/;

/** The title ends at the first `|`, so it may carry neither that nor a `]` the reader closes on. */
const UNFENCEABLE_TITLE = /[|\]\r\n]/;

/**
 * The body runs to the first `]]`, and the title/body split takes only the first `|`, so a lone `|`
 * or `]` inside the body round-trips and does not need fencing. Three things do not: `]]`, a line
 * ending (the construct then fails to tokenise at all), and a trailing `]`, which pairs with the
 * first bracket of the closing marker and cuts the body one character short.
 */
const UNFENCEABLE_BODY = /]]|]$|[\r\n]/;

export function warn(
  ctx: ReadContext,
  code: ConverterWarningCode,
  name: string,
  path: string
): void {
  ctx.warnings.push({ code, name, path });
}

export function childPath(parentPath: string, siblings: ChildNode[], index: number): string {
  const node = siblings[index] as ChildNode;
  const label = isTag(node) ? node.name : isComment(node) ? 'comment()' : 'text()';
  let ordinal = 0;
  for (let i = 0; i <= index; i++) {
    const s = siblings[i] as ChildNode;
    const sameLabel = isTag(node)
      ? isTag(s) && s.name === node.name
      : (isTag(s) ? '' : isComment(s) ? 'comment()' : 'text()') === label;
    if (sameLabel) ordinal += 1;
  }
  return `${parentPath}/${label}[${ordinal}]`;
}

/** Rendered HTML is never written back, so a view fence is an ordinary `html` code block. */
function fenceNode(ctx: ReadContext, value: string): Code {
  return ctx.mode === 'view' ? { type: 'code', lang: 'html', value } : rawFence('storage', value);
}

function fenceOf(ctx: ReadContext, node: ChildNode): RootContent {
  return fenceNode(ctx, sliceSource(ctx.src, node));
}

/** Text content of an element, decoded; CDATA raw. Used for parameters and plain bodies. */
export function textOf(el: Element): string {
  let out = '';
  for (const child of el.children) {
    if (isText(child)) out += decodeText(child.data);
    else if (isCDATA(child)) out += child.children.map((c) => (isText(c) ? c.data : '')).join('');
    else if (isTag(child)) out += textOf(child);
  }
  return out;
}

function isWhitespaceText(node: ChildNode): boolean {
  return isText(node) && decodeText(node.data).trim() === '';
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

export interface InlineResult {
  nodes: PhrasingContent[];
  /** Names of constructs with no markdown form; the caller fences the enclosing block. */
  unsupported: string[];
}

type WithChildren = PhrasingContent & { children: PhrasingContent[] };

function hasPhrasingChildren(node: PhrasingContent): node is WithChildren {
  return 'children' in node && Array.isArray((node as WithChildren).children);
}

function edgeLeaf(nodes: PhrasingContent[], side: 'first' | 'last'): PhrasingContent | undefined {
  const node = side === 'first' ? nodes[0] : nodes[nodes.length - 1];
  if (!node) return undefined;
  if (hasPhrasingChildren(node) && node.children.length > 0) return edgeLeaf(node.children, side);
  return node;
}

const HOIST_EDGES: ReadonlySet<string> = new Set(['strong', 'emphasis', 'delete']);

/**
 * `<strong> bold </strong>` means the same as ` <strong>bold</strong> `; markdown can only carry the
 * latter, so edge whitespace moves out of formatting nodes (the normaliser does the same).
 */
function hoistEdgeWhitespace(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    if (hasPhrasingChildren(node)) {
      node.children = hoistEdgeWhitespace(node.children);
      if (HOIST_EDGES.has(node.type)) {
        const first = edgeLeaf(node.children, 'first');
        if (first?.type === 'text' && first.value.startsWith(' ')) {
          first.value = first.value.slice(1);
          out.push({ type: 'text', value: ' ' });
        }
        out.push(node);
        const last = edgeLeaf(node.children, 'last');
        if (last?.type === 'text' && last.value.endsWith(' ')) {
          last.value = last.value.slice(0, -1);
          out.push({ type: 'text', value: ' ' });
        }
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

/** Whitespace runs collapse everywhere in the run; only the run's very first and last text trim. */
function collapseInlineRun(input: PhrasingContent[]): PhrasingContent[] {
  const collapse = (list: PhrasingContent[]): void => {
    for (const node of list) {
      if (node.type === 'text') node.value = node.value.replace(/[ \t\r\n]+/g, ' ');
      else if (hasPhrasingChildren(node)) collapse(node.children);
    }
  };
  collapse(input);
  // Hoisting can put two spaces side by side; merge, then collapse once more.
  const nodes = dropEmpty(hoistEdgeWhitespace(input));
  collapse(nodes);
  const first = edgeLeaf(nodes, 'first');
  if (first?.type === 'text') first.value = first.value.replace(/^ /, '');
  const last = edgeLeaf(nodes, 'last');
  if (last?.type === 'text') last.value = last.value.replace(/ $/, '');
  return dropEmpty(nodes);
}

function dropEmpty(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === 'text' && node.value === '') continue;
    if (hasPhrasingChildren(node)) node.children = dropEmpty(node.children);
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else out.push(node);
  }
  return out;
}

/**
 * A hard break at the end of a block has no markdown form: it stringifies to a dangling backslash
 * that re-parses as a literal `\`, injecting that character into the page. Inline HTML carries it
 * instead, and the writer turns it back into `<br />`.
 */
function breakSafeRun(nodes: PhrasingContent[]): PhrasingContent[] {
  const last = nodes[nodes.length - 1];
  if (last?.type !== 'break') return nodes;
  return [...nodes.slice(0, -1), { type: 'html', value: '<br />' }];
}

/** An inline run under one parent; whitespace is collapsed and trimmed at the run's edges. */
export function readInline(nodes: ChildNode[], ctx: ReadContext): InlineResult {
  const result = readInlineRaw(nodes, ctx);
  return {
    nodes: breakSafeRun(collapseInlineRun(result.nodes)),
    unsupported: result.unsupported,
  };
}

function readInlineRaw(nodes: ChildNode[], ctx: ReadContext): InlineResult {
  const out: PhrasingContent[] = [];
  const unsupported: string[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      out.push({ type: 'text', value: decodeText(node.data) });
      continue;
    }
    if (isCDATA(node)) {
      out.push({
        type: 'text',
        value: node.children.map((c) => (isText(c) ? c.data : '')).join(''),
      });
      continue;
    }
    if (isComment(node) || isDirective(node)) {
      unsupported.push(isComment(node) ? '#comment' : '#pi');
      continue;
    }
    if (!isTag(node)) continue;
    const el = node;
    const attrs = attributesOf(el);
    const inner = (): PhrasingContent[] => {
      const sub = readInlineRaw(el.children, ctx);
      unsupported.push(...sub.unsupported);
      return sub.nodes;
    };
    switch (el.name) {
      case 'strong':
      case 'b':
        out.push({ type: 'strong', children: inner() });
        break;
      case 'em':
      case 'i':
        out.push({ type: 'emphasis', children: inner() });
        break;
      case 's':
      case 'del':
      case 'strike':
        out.push({ type: 'delete', children: inner() });
        break;
      case 'code':
        out.push({ type: 'inlineCode', value: textOf(el) });
        break;
      case 'br':
        // gfm-table flattens a break to a space, so a cell keeps the tag as inline HTML.
        out.push(ctx.inCell ? { type: 'html', value: '<br />' } : { type: 'break' });
        break;
      case 'a': {
        const href = el.attribs['href'];
        const extra = attrs.filter(([n]) => n !== 'href' && n !== 'title');
        if (href === undefined || extra.length > 0) {
          unsupported.push(`a[${extra[0]?.[0] ?? 'no href'}]`);
          break;
        }
        const link: PhrasingContent = {
          type: 'link',
          url: decodeAttr(href),
          children: inner(),
        };
        if (el.attribs['title'] !== undefined) link.title = decodeAttr(el.attribs['title']);
        // Markdown writes `<a href="X">X</a>` and the plain text `X` the same way, so the writer
        // needs to know which one this page uses; `data` never reaches the markdown.
        if (selfLabelled(link)) link.data = { ...link.data, anchor: true };
        out.push(link);
        break;
      }
      case 'span':
      case 'div':
        if (attrs.length === 0) out.push(...inner());
        else unsupported.push(`${el.name}[${attrs[0]?.[0] ?? ''}]`);
        break;
      case 'ac:link':
        readAcLink(el, ctx, out, unsupported);
        break;
      case 'ac:image':
        readAcImage(el, out, unsupported);
        break;
      case 'ac:structured-macro': {
        const name = el.attribs['ac:name'] ?? '';
        if (name === 'jira') {
          const params = macroParams(el);
          const key = params.find(([k]) => k === 'key')?.[1];
          if (key && !params.some(([k]) => k === 'jqlQuery')) {
            const macro: JiraMacro = {
              type: 'jiraMacro',
              key,
              params: params.filter(([k]) => k !== 'key'),
            };
            out.push(macro);
            break;
          }
        }
        unsupported.push(`macro:${name}`);
        break;
      }
      default:
        unsupported.push(el.name);
    }
  }
  return { nodes: out, unsupported };
}

function child(el: Element, name: string): Element | undefined {
  return el.children.find((c): c is Element => isTag(c) && c.name === name);
}

function plainTextBody(el: Element): string | undefined {
  const body = child(el, 'ac:plain-text-link-body') ?? child(el, 'ac:plain-text-body');
  return body ? textOf(body) : undefined;
}

function readAcLink(
  el: Element,
  ctx: ReadContext,
  out: PhrasingContent[],
  unsupported: string[]
): void {
  if (el.attribs['ac:anchor'] !== undefined) {
    unsupported.push('ac:link[ac:anchor]');
    return;
  }
  if (child(el, 'ac:link-body')) {
    unsupported.push('ac:link-body');
    return;
  }
  const page = child(el, 'ri:page');
  const user = child(el, 'ri:user');
  const attachment = child(el, 'ri:attachment');
  const body = plainTextBody(el);
  if (page) {
    const title = page.attribs['ri:content-title'];
    // `[[Title|body]]` is one line and ends at the first `]]`. The body was unguarded, so `[[T|a]]b]]`
    // read back as a link plus stray text, and a newline anywhere stopped the construct tokenising
    // at all. The two halves have different rules: see the patterns above.
    if (title === undefined || UNFENCEABLE_TITLE.test(decodeAttr(title))) {
      unsupported.push('ri:page');
      return;
    }
    if (body !== undefined && UNFENCEABLE_BODY.test(body)) {
      unsupported.push('ri:page');
      return;
    }
    const link: PageLink = { type: 'pageLink', title: decodeAttr(title) };
    const space = page.attribs['ri:space-key'];
    if (space !== undefined) link.space = decodeAttr(space);
    if (body !== undefined) link.body = body;
    out.push(link);
    return;
  }
  if (user) {
    const key = user.attribs['ri:userkey'];
    const name = user.attribs['ri:username'];
    if (key !== undefined) {
      ctx.shapes.mentionAttributes.push('userkey');
      const username = ctx.users.usernameForKey(key);
      const mention: Mention = username
        ? { type: 'mention', username }
        : { type: 'mention', username: '', userKey: key };
      if (!username) warn(ctx, 'user-unresolved', key, ctx.path);
      out.push(mention);
      return;
    }
    if (name !== undefined) {
      ctx.shapes.mentionAttributes.push('username');
      out.push({ type: 'mention', username: decodeAttr(name) } as Mention);
      return;
    }
    unsupported.push('ri:user');
    return;
  }
  if (attachment) {
    const file = attachment.attribs['ri:filename'];
    if (file === undefined || child(attachment, 'ri:page')) {
      unsupported.push('ri:attachment');
      return;
    }
    const filename = decodeAttr(file);
    out.push({
      type: 'link',
      url: `attachment:${filename}`,
      children: [{ type: 'text', value: body ?? filename }],
    });
    return;
  }
  unsupported.push('ac:link');
}

function readAcImage(el: Element, out: PhrasingContent[], unsupported: string[]): void {
  const attachment = child(el, 'ri:attachment');
  const url = child(el, 'ri:url');
  const words: Array<[string, string]> = [];
  let alt: string | null = null;
  for (const [name, value] of attributesOf(el)) {
    if (name === 'ac:alt') {
      alt = value;
      continue;
    }
    if (!name.startsWith('ac:') || !IMAGE_PARAM_VALUE.test(value)) {
      unsupported.push(`ac:image[${name}]`);
      return;
    }
    words.push([name.slice(3), value]);
  }
  words.sort(([a], [b]) => a.localeCompare(b));
  let target: string | undefined;
  if (attachment !== undefined && child(attachment, 'ri:page')) {
    // An attachment of a different page; `attachment:` in markdown means this page's own.
    unsupported.push('ri:attachment[ri:page]');
    return;
  }
  if (attachment?.attribs['ri:filename'] !== undefined)
    target = `attachment:${decodeAttr(attachment.attribs['ri:filename'])}`;
  else if (url?.attribs['ri:value'] !== undefined) target = decodeAttr(url.attribs['ri:value']);
  if (target === undefined) {
    unsupported.push('ac:image');
    return;
  }
  const image: PhrasingContent = { type: 'image', url: target, alt };
  if (words.length > 0) image.title = encodeParams(words);
  out.push(image);
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function paragraphOrFence(
  el: Element,
  ctx: ReadContext,
  path: string,
  kind: 'paragraph' | 'heading',
  depth?: number
): RootContent {
  const sub = readInline(el.children, { ...ctx, path });
  if (sub.unsupported.length > 0) {
    warn(ctx, 'inline-unknown', sub.unsupported[0] as string, path);
    return fenceOf(ctx, el);
  }
  if (kind === 'heading')
    return { type: 'heading', depth: (depth ?? 1) as 1 | 2 | 3 | 4 | 5 | 6, children: sub.nodes };
  return { type: 'paragraph', children: sub.nodes };
}

/** Consecutive non-block children under a block container form one paragraph (or one fence). */
function readInlineRunAsBlock(
  run: ChildNode[],
  ctx: ReadContext,
  path: string
): RootContent | undefined {
  const sub = readInline(run, { ...ctx, path });
  if (sub.unsupported.length > 0) {
    warn(ctx, 'inline-unknown', sub.unsupported[0] as string, path);
    return fenceNode(
      ctx,
      sliceRange(ctx.src, run[0] as ChildNode, run[run.length - 1] as ChildNode)
    );
  }
  if (sub.nodes.length === 0) return undefined;
  return { type: 'paragraph', children: sub.nodes };
}

export function readBlocks(nodes: ChildNode[], ctx: ReadContext): RootContent[] {
  const out: RootContent[] = [];
  let run: ChildNode[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const first = run[0] as ChildNode;
    const block = readInlineRunAsBlock(run, ctx, childPath(ctx.path, nodes, nodes.indexOf(first)));
    if (block) out.push(block);
    run = [];
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as ChildNode;
    if (isText(node) && isWhitespaceText(node)) {
      // Layout whitespace between blocks; inside a run it is real (collapsed later).
      if (run.length > 0) run.push(node);
      continue;
    }
    if (isComment(node) || isDirective(node)) {
      flushRun();
      warn(
        ctx,
        'block-unknown',
        isComment(node) ? '#comment' : '#pi',
        childPath(ctx.path, nodes, i)
      );
      out.push(fenceOf(ctx, node));
      continue;
    }
    if (!isTag(node)) {
      run.push(node);
      continue;
    }
    if (node.name === 'br') {
      // A stray line break between blocks is an empty line in the editor.
      flushRun();
      out.push({ type: 'html', value: '<br />' });
      continue;
    }
    if (!isBlockLevelName(node.name) || (ctx.inListItem && isKeyedJiraMacro(node))) {
      // Formatting or links directly under a block container: part of a bare inline run.
      run.push(node);
      continue;
    }
    flushRun();
    out.push(...readBlockElement(node, ctx, childPath(ctx.path, nodes, i)));
  }
  flushRun();
  return out;
}

const BLOCK_LEVEL_EXTRA: ReadonlySet<string> = new Set([
  'ac:structured-macro',
  'ac:macro',
  'ac:task-list',
  'ac:layout',
  'ac:rich-text-body',
  'colgroup',
  'thead',
  'tbody',
  'tr',
]);

/** Block children that are really blocks: a keyed jira macro is inline wherever it sits. */
function hasRealBlockChildren(el: Element): boolean {
  return el.children.some((c) => isTag(c) && BLOCK_ELEMENTS.has(c.name) && !isKeyedJiraMacro(c));
}

/** `{jira:KEY}` is inline in a paragraph; the writer puts it directly under `li` in tight items. */
function isKeyedJiraMacro(el: Element): boolean {
  if (el.name !== 'ac:structured-macro' || el.attribs['ac:name'] !== 'jira') return false;
  const params = macroParams(el);
  return params.some(([k]) => k === 'key') && !params.some(([k]) => k === 'jqlQuery');
}

function isBlockLevelName(name: string): boolean {
  return BLOCK_ELEMENTS.has(name) || BLOCK_LEVEL_EXTRA.has(name) || HEADINGS.has(name);
}

function readBlockElement(el: Element, ctx: ReadContext, path: string): RootContent[] {
  const attrs = attributesOf(el);
  const fence = (name: string, code: ConverterWarningCode = 'block-unknown'): RootContent[] => {
    warn(ctx, code, name, path);
    return [fenceOf(ctx, el)];
  };
  if (HEADINGS.has(el.name)) {
    if (attrs.length > 0) return fence(`${el.name}[${attrs[0]?.[0] ?? ''}]`, 'attribute-unknown');
    return [paragraphOrFence(el, ctx, path, 'heading', Number(el.name[1]))];
  }
  switch (el.name) {
    case 'p': {
      if (attrs.length > 0) return fence(`p[${attrs[0]?.[0] ?? ''}]`, 'attribute-unknown');
      const meaningful = el.children.filter((c) => !isWhitespaceText(c));
      if (
        meaningful.length === 1 &&
        isTag(meaningful[0] as ChildNode) &&
        (meaningful[0] as Element).name === 'br'
      ) {
        return [{ type: 'html', value: '<br />' }];
      }
      if (meaningful.length === 0) return [];
      return [paragraphOrFence(el, ctx, path, 'paragraph')];
    }
    case 'hr':
      return [{ type: 'thematicBreak' }];
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          children: readBlocks(el.children, { ...ctx, path }) as BlockContent[],
        },
      ];
    case 'div':
      if (attrs.length > 0) return fence(`div[${attrs[0]?.[0] ?? ''}]`);
      return readBlocks(el.children, { ...ctx, path });
    case 'ul':
    case 'ol':
      return readList(el, ctx, path);
    case 'table':
      return readTable(el, ctx, path);
    case 'ac:task-list':
      return readTaskList(el, ctx, path);
    case 'ac:structured-macro': {
      const result = readMacro(el, ctx, path);
      if (result === 'escalate') return fence(`macro:${el.attribs['ac:name'] ?? ''}`);
      return result;
    }
    default:
      return fence(el.name);
  }
}

function readList(el: Element, ctx: ReadContext, path: string): RootContent[] {
  const attrs = attributesOf(el).filter(([n]) => !(el.name === 'ol' && n === 'start'));
  if (attrs.length > 0) {
    warn(ctx, 'attribute-unknown', `${el.name}[${attrs[0]?.[0] ?? ''}]`, path);
    return [fenceOf(ctx, el)];
  }
  const items: ListItem[] = [];
  let spread = false;
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const li = children[i] as ChildNode;
    if (isWhitespaceText(li)) continue;
    if (!isTag(li) || li.name !== 'li' || attributesOf(li).length > 0) {
      warn(ctx, 'block-unknown', isTag(li) ? li.name : 'text()', childPath(path, children, i));
      return [fenceOf(ctx, el)];
    }
    const liPath = childPath(path, children, i);
    if (hasRealBlockChildren(li)) {
      const blocks = readBlocks(li.children, { ...ctx, path: liPath, inListItem: true });
      if (li.children.some((c) => isTag(c) && c.name === 'p')) spread = true;
      // Sibling blocks in one item need the blank line between them that `spread` asks for, or a
      // rule after a paragraph re-reads as a setext heading and swallows the paragraph text. A
      // nested list is not such a sibling: it follows the item text in the ordinary tight form.
      const siblings = blocks.filter((b) => b.type !== 'list').length;
      items.push({
        type: 'listItem',
        spread: siblings > 1,
        children: blocks as BlockContent[],
      });
      continue;
    }
    const sub = readInline(li.children, { ...ctx, path: liPath });
    if (sub.unsupported.length > 0) {
      warn(ctx, 'inline-unknown', sub.unsupported[0] as string, liPath);
      const inline = li.children.filter((c) => !isWhitespaceText(c));
      const raw =
        inline.length > 0
          ? sliceRange(ctx.src, inline[0] as ChildNode, inline[inline.length - 1] as ChildNode)
          : '';
      items.push({ type: 'listItem', spread: false, children: [fenceNode(ctx, raw)] });
      continue;
    }
    items.push({
      type: 'listItem',
      spread: false,
      children: sub.nodes.length > 0 ? [{ type: 'paragraph', children: sub.nodes }] : [],
    });
  }
  const list: RootContent = { type: 'list', ordered: el.name === 'ol', spread, children: items };
  const start = el.attribs['start'];
  if (el.name === 'ol' && start !== undefined && /^\d+$/.test(start)) list.start = Number(start);
  return [list];
}

function readTaskList(el: Element, ctx: ReadContext, path: string): RootContent[] {
  const items: ListItem[] = [];
  const children = el.children;
  for (let i = 0; i < children.length; i++) {
    const task = children[i] as ChildNode;
    if (isWhitespaceText(task)) continue;
    if (!isTag(task) || task.name !== 'ac:task') {
      warn(ctx, 'block-unknown', isTag(task) ? task.name : 'text()', childPath(path, children, i));
      return [fenceOf(ctx, el)];
    }
    const status = child(task, 'ac:task-status');
    const body = child(task, 'ac:task-body');
    if (!status || !body || hasRealBlockChildren(body) || child(body, 'ac:task-list')) {
      warn(ctx, 'block-unknown', 'ac:task', childPath(path, children, i));
      return [fenceOf(ctx, el)];
    }
    // The editor wraps the text in a placeholder span, which carries nothing. Any other span does
    // carry something (a colour, say), so it must escalate like it would anywhere else.
    const only = body.children.length === 1 ? (body.children[0] as ChildNode) : undefined;
    const placeholder =
      only !== undefined &&
      isTag(only) &&
      only.name === 'span' &&
      attributesOf(only).every(([n, v]) => n === 'class' && v === 'placeholder-inline-tasks');
    const inner = placeholder ? (only as Element).children : body.children;
    ctx.shapes.taskBodies.push(placeholder ? 'span' : 'bare');
    const sub = readInline(inner, { ...ctx, path: childPath(path, children, i) });
    if (sub.unsupported.length > 0) {
      warn(ctx, 'inline-unknown', sub.unsupported[0] as string, childPath(path, children, i));
      return [fenceOf(ctx, el)];
    }
    items.push({
      type: 'listItem',
      spread: false,
      checked: textOf(status).trim() === 'complete',
      children: [{ type: 'paragraph', children: sub.nodes }],
    });
  }
  return [{ type: 'list', ordered: false, spread: false, children: items }];
}

function readTable(el: Element, ctx: ReadContext, path: string): RootContent[] {
  const fail = (name: string): RootContent[] => {
    warn(ctx, 'table-shape', name, path);
    return [fenceOf(ctx, el)];
  };
  const attrs = attributesOf(el);
  // Name the attribute that failed, not the first one: `<table class="wrapped" style="…">` used to
  // be reported as `table[class]`, which is the one attribute that is allowed.
  const offending = attrs.find(([n, v]) => !(n === 'class' && v === 'wrapped'));
  if (offending) return fail(`table[${offending[0]}]`);
  const wrapped = attrs.length === 1;
  let hasColgroup = false;
  const rows: Element[] = [];
  for (const section of el.children) {
    if (isWhitespaceText(section) || !isTag(section)) {
      if (!isWhitespaceText(section)) return fail('text');
      continue;
    }
    if (section.name === 'colgroup') {
      if (
        section.children.some((c) => isTag(c) && (c.name !== 'col' || attributesOf(c).length > 0))
      )
        return fail('colgroup');
      hasColgroup = true;
      continue;
    }
    if (section.name === 'tr') {
      rows.push(section);
      continue;
    }
    if (section.name !== 'thead' && section.name !== 'tbody') return fail(section.name);
    if (attributesOf(section).length > 0)
      return fail(`${section.name}[${attributesOf(section)[0]?.[0] ?? ''}]`);
    for (const tr of section.children) {
      if (isWhitespaceText(tr)) continue;
      if (!isTag(tr) || tr.name !== 'tr' || attributesOf(tr).length > 0) return fail('tr');
      rows.push(tr);
    }
  }
  if (rows.length === 0) return fail('empty');
  const cellsPerRow = rows.map((tr) => tr.children.filter((c): c is Element => isTag(c)));
  if (rows.some((tr) => tr.children.some((c) => !isTag(c) && !isWhitespaceText(c))))
    return fail('text');
  // Before the width check, so a `colspan` is reported as itself rather than as a ragged table.
  for (const cells of cellsPerRow) {
    for (const cell of cells) {
      const attr = attributesOf(cell)[0]?.[0];
      if (attr !== undefined) return fail(attr);
    }
  }
  const width = cellsPerRow[0]?.length ?? 0;
  if (width === 0 || cellsPerRow.some((cells) => cells.length !== width)) return fail('ragged');
  let cellWrap: 'none' | 'p' | undefined;
  const mdRows: TableRow[] = [];
  const headerRow = cellsPerRow[0] as Element[];
  const allTh = headerRow.every((c) => c.name === 'th');
  const anyTh = cellsPerRow.some((cells) => cells.some((c) => c.name === 'th'));
  if (anyTh && !allTh) return fail('mixed-th');
  if (cellsPerRow.slice(1).some((cells) => cells.some((c) => c.name === 'th')))
    return fail('th-body');
  for (const cells of cellsPerRow) {
    const mdCells = [];
    for (const cell of cells) {
      if (cell.name !== 'td' && cell.name !== 'th') return fail(cell.name);
      let content = cell.children;
      const meaningful = content.filter((c) => !isWhitespaceText(c));
      if (
        meaningful.length === 1 &&
        isTag(meaningful[0] as ChildNode) &&
        (meaningful[0] as Element).name === 'p'
      ) {
        if (attributesOf(meaningful[0] as Element).length > 0) return fail('p[attr]');
        if (cellWrap === 'none') return fail('cell-wrap');
        cellWrap = 'p';
        content = (meaningful[0] as Element).children;
      } else if (meaningful.length > 0) {
        if (hasRealBlockChildren(cell)) return fail('block-cell');
        if (cellWrap === 'p') return fail('cell-wrap');
        cellWrap = 'none';
      }
      const sub = readInline(content, { ...ctx, path, inCell: true });
      if (sub.unsupported.length > 0) return fail(sub.unsupported[0] as string);
      mdCells.push({ type: 'tableCell' as const, children: sub.nodes });
    }
    mdRows.push({ type: 'tableRow', children: mdCells });
  }
  if (!allTh) {
    mdRows.unshift({
      type: 'tableRow',
      children: Array.from({ length: width }, () => ({ type: 'tableCell' as const, children: [] })),
    });
  }
  ctx.shapes.tableShells.push(wrapped ? (hasColgroup ? 'wrapped-colgroup' : 'wrapped') : 'plain');
  ctx.shapes.cellWraps.push(cellWrap ?? 'none');
  return [{ type: 'table', align: Array.from({ length: width }, () => null), children: mdRows }];
}

/** Storage → mdast. Tolerant: anything not understood becomes a raw fence with its exact source. */
/** A link whose only child is its own URL; the two storage forms collapse onto one markdown text. */
export function selfLabelled(node: Link): string | undefined {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  if (!only || only.type !== 'text' || node.title) return undefined;
  const text = only.value;
  if (node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`)
    return text;
  return undefined;
}

function recordAutolinks(tree: Root, shapes: PageShapes): void {
  visit(tree, 'link', (node: Link) => {
    if (selfLabelled(node) === undefined) return;
    const data = node.data as Record<string, unknown> | undefined;
    shapes.autolinks.push(data?.['anchor'] === true ? 'anchor' : 'text');
  });
}

export function storageToMdast(storage: string, opts: ReadOptions = {}): ReadResult {
  const { src, doc } = parseStorage(storage);
  const ctx = createReadContext(src, opts.users ?? EMPTY_DIRECTORY, 'storage');
  const children = readBlocks(doc.children, ctx);
  const tree = autolinkLiterals({ type: 'root', children });
  recordAutolinks(tree, ctx.shapes);
  return { tree, warnings: ctx.warnings, shapes: ctx.shapes };
}

export { VERBATIM };
