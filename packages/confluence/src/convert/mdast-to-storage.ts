import { LassiError, RAW_FENCE_LANGS, type Mention } from '@wonna/lassi-core';
import type {
  Blockquote,
  Code,
  Definition,
  Heading,
  Html,
  Image,
  Link,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { toString } from 'mdast-util-to-string';
import type { Alert, AlertKind } from './md/alert.js';
import type { JiraMacro } from './md/jiramacro.js';
import type { PageLink } from './md/pagelink.js';
import { parseConfluenceMarkdown } from './md/index.js';
import { decodeParams, type Params } from './params.js';
import { selfLabelled } from './storage-to-mdast.js';
import { EMPTY_DIRECTORY, type UserDirectory } from './users.js';
import { StorageWarnings, type StorageWarning } from './warnings.js';
import { DEFAULT_WRITER_OPTIONS, type StorageWriterOptions } from './writer-options.js';
import { cdata, escapeAttr, escapeText } from './xml/escape.js';

export interface WriteOptions {
  users?: UserDirectory;
  writer?: Partial<StorageWriterOptions>;
}

export interface WriteResult {
  storage: string;
  warnings: StorageWarning[];
}

const HINT =
  'wrap storage XHTML the dialect cannot express in a ```confluence fence; it is sent verbatim';

interface Ctx {
  users: UserDirectory;
  writer: StorageWriterOptions;
  warnings: StorageWarnings;
  definitions: Map<string, Definition>;
}

interface Positioned {
  position?: { start: { line: number } } | undefined;
}

function fail(message: string, node?: Positioned): never {
  const line = node?.position?.start.line;
  throw new LassiError('validation', line === undefined ? message : `${message} (line ${line})`, {
    hint: HINT,
  });
}

function attr(name: string, value: string): string {
  return ` ${name}="${escapeAttr(value)}"`;
}

function param(name: string, value: string): string {
  return `<ac:parameter ac:name="${escapeAttr(name)}">${escapeText(value)}</ac:parameter>`;
}

function macro(name: string, inner: string): string {
  return inner === ''
    ? `<ac:structured-macro ac:name="${name}" />`
    : `<ac:structured-macro ac:name="${name}">${inner}</ac:structured-macro>`;
}

const BR = /^<br\s*\/?>$/i;
const TOC = /^<!--\s*toc(?:\s+([\s\S]*?))?\s*-->$/;

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

function plainLabel(node: Link, ctx: Ctx): string {
  const text = toString(node);
  if (!node.children.every((c) => c.type === 'text')) {
    ctx.warnings.add(
      'link-label-flattened',
      `link label "${text}" lost its formatting (Confluence link bodies are plain text)`,
      node
    );
  }
  return text;
}

function renderLink(node: Link, ctx: Ctx): string {
  const literal = selfLabelled(node);
  if (literal !== undefined) {
    // The editor links every URL it is given, so writing plain text here would strip the anchor
    // off most real pages; a page that keeps its URLs as text keeps them.
    return ctx.writer.autolink === 'anchor'
      ? `<a${attr('href', node.url)}>${escapeText(literal)}</a>`
      : escapeText(literal);
  }
  if (node.url.startsWith('attachment:')) {
    const filename = node.url.slice('attachment:'.length);
    if (filename === '') fail('attachment link without a file name', node);
    const label = plainLabel(node, ctx);
    const body =
      label === filename || label === ''
        ? ''
        : `<ac:plain-text-link-body>${cdata(label)}</ac:plain-text-link-body>`;
    return `<ac:link><ri:attachment${attr('ri:filename', filename)} />${body}</ac:link>`;
  }
  const title = node.title ? attr('title', node.title) : '';
  return `<a${attr('href', node.url)}${title}>${renderInline(node.children, ctx)}</a>`;
}

function renderImage(node: Image, ctx: Ctx): string {
  let attrs = '';
  if (node.alt) attrs += attr('ac:alt', node.alt);
  if (node.title) {
    const params = decodeParams(node.title);
    if (params === undefined) {
      ctx.warnings.add(
        'image-title-dropped',
        `image title "${node.title}" is not key=value words and was dropped`,
        node
      );
    } else {
      for (const [key, value] of params) attrs += attr(`ac:${key}`, value);
    }
  }
  let target: string;
  if (node.url.startsWith('attachment:')) {
    target = `<ri:attachment${attr('ri:filename', node.url.slice('attachment:'.length))} />`;
  } else if (/^https?:\/\//i.test(node.url)) {
    target = `<ri:url${attr('ri:value', node.url)} />`;
  } else {
    return fail(
      `image "${node.url}" must be an attachment (attachment:file.png) or an http(s) URL`,
      node
    );
  }
  return `<ac:image${attrs}>${target}</ac:image>`;
}

function renderMention(node: Mention, ctx: Ctx): string {
  let inner: string;
  if (node.username === '' && node.userKey) {
    // The `@{userkey:…}` placeholder for a key the directory could not resolve; written verbatim.
    inner = `<ri:user${attr('ri:userkey', node.userKey)} />`;
  } else if (ctx.writer.mentionAttribute === 'username') {
    inner = `<ri:user${attr('ri:username', node.username)} />`;
  } else {
    const key = ctx.users.keyForUsername(node.username);
    if (key === undefined) {
      throw new LassiError('validation', `unknown user @${node.username}`, {
        hint: 'mentions must be Confluence usernames; the write validates them before sending',
      });
    }
    // A known user with no key: `<ri:user ri:userkey="" />` names nobody. The same user is writable
    // on a page whose convention is `ri:username`, so this is refused here and not at validation.
    if (key === '') {
      throw new LassiError(
        'validation',
        `@${node.username} has no user key, and this page is written with ri:userkey mentions`,
        {
          hint: 'the directory has no key for that user; mention someone else, or edit a page that uses ri:username mentions',
        }
      );
    }
    inner = `<ri:user${attr('ri:userkey', key)} />`;
  }
  return `<ac:link>${inner}</ac:link>`;
}

function renderPageLink(node: PageLink): string {
  // `[[:Title]]` parses with an empty space key: the guard for titles that look like `SPACE:Title`.
  const space = node.space ? attr('ri:space-key', node.space) : '';
  const body =
    node.body === undefined
      ? ''
      : `<ac:plain-text-link-body>${cdata(node.body)}</ac:plain-text-link-body>`;
  return `<ac:link><ri:page${space}${attr('ri:content-title', node.title)} />${body}</ac:link>`;
}

function renderJiraMacro(node: JiraMacro): string {
  const params: Params = [['key', node.key], ...node.params];
  return macro('jira', params.map(([k, v]) => param(k, v)).join(''));
}

function resolveDefinition(
  node: { identifier: string; label?: string | null | undefined } & Positioned,
  ctx: Ctx
): Definition {
  const definition = ctx.definitions.get(node.identifier.toLowerCase());
  if (!definition) fail(`unresolved reference [${node.label ?? node.identifier}]`, node);
  return definition;
}

function renderInlineNode(node: PhrasingContent, ctx: Ctx): string {
  switch (node.type) {
    case 'text':
      return escapeText(node.value);
    case 'strong':
      return `<strong>${renderInline(node.children, ctx)}</strong>`;
    case 'emphasis':
      return `<em>${renderInline(node.children, ctx)}</em>`;
    case 'delete':
      return `<s>${renderInline(node.children, ctx)}</s>`;
    case 'inlineCode':
      return `<code>${escapeText(node.value)}</code>`;
    case 'break':
      return '<br />';
    case 'html':
      if (BR.test(node.value.trim())) return '<br />';
      return fail(`inline HTML is not supported in Confluence storage: ${node.value}`, node);
    case 'link':
      return renderLink(node, ctx);
    case 'image':
      return renderImage(node, ctx);
    case 'linkReference': {
      const def = resolveDefinition(node, ctx);
      const link: Link = { type: 'link', url: def.url, children: node.children };
      if (def.title) link.title = def.title;
      return renderLink(link, ctx);
    }
    case 'imageReference': {
      const def = resolveDefinition(node, ctx);
      const image: Image = { type: 'image', url: def.url, alt: node.alt ?? null };
      if (def.title) image.title = def.title;
      return renderImage(image, ctx);
    }
    case 'footnoteReference':
      return fail('footnotes are not supported in Confluence storage', node);
    default: {
      const other = node as Nodes;
      if (other.type === 'mention') return renderMention(other as Mention, ctx);
      if (other.type === 'pageLink') return renderPageLink(other as PageLink);
      if (other.type === 'jiraMacro') return renderJiraMacro(other as JiraMacro);
      return fail(`unsupported inline node: ${other.type}`, other as Positioned);
    }
  }
}

function renderInline(nodes: PhrasingContent[], ctx: Ctx): string {
  return nodes.map((n) => renderInlineNode(n, ctx)).join('');
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function renderCode(node: Code, ctx: Ctx): string {
  if (node.lang === RAW_FENCE_LANGS.storage) return node.value;
  const params: Params = [];
  // `noformat` is the macro name, not a language, so it carries no `language` parameter; its other
  // parameters (`nopanel`, and so on) round-trip like any other macro's and used to be dropped here
  // without a word.
  if (node.lang && node.lang !== 'noformat') params.push(['language', node.lang]);
  if (node.meta) {
    const extra = decodeParams(node.meta);
    if (extra === undefined) {
      ctx.warnings.add(
        'code-meta-dropped',
        `code fence meta "${node.meta}" is not key=value words and was dropped`,
        node
      );
    } else {
      params.push(...extra);
    }
  }
  const body = `${params.map(([k, v]) => param(k, v)).join('')}<ac:plain-text-body>${cdata(node.value)}</ac:plain-text-body>`;
  return macro(node.lang === 'noformat' ? 'noformat' : 'code', body);
}

const PANEL_NAMES: Record<AlertKind, string | undefined> = {
  note: 'info',
  tip: 'tip',
  warning: 'warning',
  important: 'note',
  caution: undefined,
};

function renderAlert(node: Alert, ctx: Ctx): string {
  // Guarded like the reader's lookup: the parser constrains `kind`, but a tree handed in by a
  // library consumer does not, and a bare index would answer `constructor` with a function.
  const name = Object.hasOwn(PANEL_NAMES, node.kind) ? PANEL_NAMES[node.kind] : undefined;
  if (name === undefined) {
    return fail(
      '[!CAUTION] has no Confluence panel; use [!WARNING], [!NOTE], [!TIP] or [!IMPORTANT]',
      node
    );
  }
  const title = node.title ? param('title', node.title) : '';
  return macro(
    name,
    `${title}<ac:rich-text-body>${renderBlocks(node.children, ctx)}</ac:rich-text-body>`
  );
}

function isTask(item: ListItem): boolean {
  return typeof item.checked === 'boolean';
}

/** `<li>text<ul>…</ul></li>` unless the list is loose or the item holds other blocks. */
function renderListItem(item: ListItem, list: List, ctx: Ctx): string {
  const kids = item.children;
  // One spread item makes the whole list loose in markdown, so every item gets `<p>` children.
  const loose = list.spread || list.children.some((i) => i.spread);
  const inlineForm =
    !loose &&
    kids.every((k, i) => (i === 0 && k.type === 'paragraph') || k.type === 'list') &&
    kids.filter((k) => k.type === 'list').length <= 1;
  if (inlineForm) {
    return kids
      .map((k) => (k.type === 'paragraph' ? renderInline(k.children, ctx) : renderBlock(k, ctx)))
      .join('');
  }
  return renderBlocks(kids, ctx);
}

function renderTaskList(node: List, ctx: Ctx): string {
  const tasks = node.children.map((item) => {
    if (!isTask(item)) {
      return fail(
        'a task list cannot mix `- [ ]` items with plain items in Confluence; split the list',
        item
      );
    }
    const only = item.children.length === 1 ? item.children[0] : undefined;
    if (!only || only.type !== 'paragraph') {
      return fail(
        'a Confluence task holds one line of text; move other blocks out of the item',
        item
      );
    }
    const status = item.checked ? 'complete' : 'incomplete';
    const text = renderInline(only.children, ctx);
    const body =
      ctx.writer.taskBody === 'span'
        ? `<span class="placeholder-inline-tasks">${text}</span>`
        : text;
    return `<ac:task><ac:task-status>${status}</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task>`;
  });
  return `<ac:task-list>${tasks.join('')}</ac:task-list>`;
}

function renderList(node: List, ctx: Ctx): string {
  if (node.children.some(isTask)) return renderTaskList(node, ctx);
  const items = node.children.map((item) => `<li>${renderListItem(item, node, ctx)}</li>`).join('');
  if (node.ordered) {
    const start =
      node.start !== null && node.start !== undefined && node.start !== 1
        ? ` start="${node.start}"`
        : '';
    return `<ol${start}>${items}</ol>`;
  }
  return `<ul>${items}</ul>`;
}

function renderCell(cell: TableCell, header: boolean, ctx: Ctx): string {
  const tag = header ? 'th' : 'td';
  const inner = renderInline(cell.children, ctx);
  const body = ctx.writer.cellWrap === 'p' && inner !== '' ? `<p>${inner}</p>` : inner;
  return `<${tag}>${body}</${tag}>`;
}

function renderTable(node: Table, ctx: Ctx): string {
  const [header, ...rows] = node.children;
  if (!header) return fail('a table needs a header row', node);
  const width = header.children.length;
  const emptyHeader = header.children.every((c) => c.children.length === 0);
  const out: string[] = [];
  if (!emptyHeader)
    out.push(`<tr>${header.children.map((c) => renderCell(c, true, ctx)).join('')}</tr>`);
  for (const row of rows) {
    if (row.children.length > width) {
      return fail(`table row has ${row.children.length} cells but the header has ${width}`, row);
    }
    const cells = [...row.children];
    while (cells.length < width) cells.push({ type: 'tableCell', children: [] });
    out.push(`<tr>${cells.map((c) => renderCell(c, false, ctx)).join('')}</tr>`);
  }
  const shell = ctx.writer.tableShell;
  const open = shell === 'plain' ? '<table>' : '<table class="wrapped">';
  const colgroup =
    shell === 'wrapped-colgroup' ? `<colgroup>${'<col />'.repeat(width)}</colgroup>` : '';
  return `${open}${colgroup}<tbody>${out.join('')}</tbody></table>`;
}

function renderHtmlBlock(node: Html, ctx: Ctx): string {
  const value = node.value.trim();
  if (BR.test(value)) return '<p><br /></p>';
  const toc = TOC.exec(value);
  if (toc) {
    const rest = toc[1]?.trim() ?? '';
    if (rest === '') return macro('toc', '');
    const params = decodeParams(rest);
    if (params === undefined) {
      ctx.warnings.add(
        'toc-params-dropped',
        `toc parameters "${rest}" are not key=value words and were dropped`,
        node
      );
      return macro('toc', '');
    }
    return macro('toc', params.map(([k, v]) => param(k, v)).join(''));
  }
  return fail(`HTML blocks are not supported in Confluence storage: ${value.slice(0, 60)}`, node);
}

function renderBlock(node: RootContent, ctx: Ctx): string {
  switch (node.type) {
    case 'heading': {
      const h = node as Heading;
      return `<h${h.depth}>${renderInline(h.children, ctx)}</h${h.depth}>`;
    }
    case 'paragraph':
      return `<p>${renderInline((node as Paragraph).children, ctx)}</p>`;
    case 'thematicBreak':
      return '<hr />';
    case 'blockquote':
      return `<blockquote>${renderBlocks((node as Blockquote).children, ctx)}</blockquote>`;
    case 'code':
      return renderCode(node, ctx);
    case 'list':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node, ctx);
    case 'html':
      return renderHtmlBlock(node, ctx);
    case 'definition':
      return '';
    case 'footnoteDefinition':
      return fail('footnotes are not supported in Confluence storage', node);
    case 'yaml':
      return fail('frontmatter must be split off before conversion', node);
    default: {
      const other = node as Nodes;
      if (other.type === 'alert') return renderAlert(other as Alert, ctx);
      return fail(`unsupported block node: ${other.type}`, other as Positioned);
    }
  }
}

function renderBlocks(nodes: RootContent[], ctx: Ctx): string {
  return nodes.map((n) => renderBlock(n, ctx)).join('');
}

function collectDefinitions(tree: Root, ctx: Ctx): void {
  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        ctx.definitions.set(node.identifier.toLowerCase(), node);
        ctx.warnings.add(
          'reference-consumed',
          `reference definition [${node.label ?? node.identifier}] was resolved inline`,
          node
        );
      } else if ('children' in node && Array.isArray(node.children)) {
        walk(node.children as RootContent[]);
      }
    }
  };
  walk(tree.children);
}

/**
 * mdast → storage XHTML. A string builder over the canonical dialect: blocks
 * are concatenated without whitespace, text is escaped, ```confluence fences pass through verbatim,
 * and anything the storage format cannot carry is a validation error naming the fence escape hatch.
 */
export function mdastToStorage(tree: Root, opts: WriteOptions = {}): WriteResult {
  const ctx: Ctx = {
    users: opts.users ?? EMPTY_DIRECTORY,
    writer: { ...DEFAULT_WRITER_OPTIONS, ...opts.writer },
    warnings: new StorageWarnings(),
    definitions: new Map(),
  };
  collectDefinitions(tree, ctx);
  return { storage: renderBlocks(tree.children, ctx), warnings: ctx.warnings.list };
}

export function markdownToStorage(markdown: string, opts: WriteOptions = {}): WriteResult {
  return mdastToStorage(parseConfluenceMarkdown(markdown), opts);
}
