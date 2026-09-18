import { autolinkLiterals } from '@wonna/lassi-core';
import { Element, Text, isTag, isText, type ChildNode, type Document } from 'domhandler';
import { replaceElement } from 'domutils';
import { parseDocument } from 'htmlparser2';
import {
  createReadContext,
  readBlocks,
  type ReadOptions,
  type ReadResult,
} from './storage-to-mdast.js';
import { EMPTY_DIRECTORY } from './users.js';
import { escapeAttr, escapeText } from './xml/escape.js';
import { decodeAttr } from './xml/parse.js';

/**
 * Rendered ("view") HTML → mdast, for `page get --format view`. The rendered markup is rewritten
 * into the storage elements the storage reader already understands (macros, links, images, task
 * lists), presentation attributes the renderer adds are dropped, and everything else goes through
 * the same handlers, so both formats read alike. View files are never written back.
 */
export function viewToMdast(html: string, opts: ReadOptions = {}): ReadResult {
  const doc = parseDocument(html, {
    decodeEntities: false,
    withStartIndices: true,
    withEndIndices: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
  rewriteView(doc);
  const ctx = createReadContext(html, opts.users ?? EMPTY_DIRECTORY, 'view');
  const children = readBlocks(doc.children, ctx);
  return {
    tree: autolinkLiterals({ type: 'root', children }),
    warnings: ctx.warnings,
    shapes: ctx.shapes,
  };
}

// ---------------------------------------------------------------------------------------------
// DOM rewriting
// ---------------------------------------------------------------------------------------------

function classes(el: Element): Set<string> {
  return new Set((el.attribs['class'] ?? '').split(/\s+/).filter((c) => c.length > 0));
}

function allElements(node: Document | Element, out: Element[] = []): Element[] {
  for (const child of node.children) {
    if (isTag(child)) {
      out.push(child);
      allElements(child, out);
    }
  }
  return out;
}

function findDescendant(el: Element, test: (e: Element) => boolean): Element | undefined {
  for (const child of el.children) {
    if (!isTag(child)) continue;
    if (test(child)) return child;
    const deep = findDescendant(child, test);
    if (deep) return deep;
  }
  return undefined;
}

/** Raw (still entity-encoded) text of all descendant text nodes; the reader decodes it. */
function rawText(el: Element): string {
  let out = '';
  for (const child of el.children) {
    if (isText(child)) out += child.data;
    else if (isTag(child)) out += rawText(child);
  }
  return out;
}

function link(children: ChildNode[], parent: Element): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as ChildNode;
    child.parent = parent;
    child.prev = children[i - 1] ?? null;
    child.next = children[i + 1] ?? null;
  }
}

function element(
  name: string,
  attribs: Record<string, string>,
  children: ChildNode[] = []
): Element {
  const el = new Element(name, attribs, children);
  link(children, el);
  return el;
}

/** Replaces `el` with `replacement`, keeping the source offsets so a fence slices the original. */
function swap(el: Element, replacement: Element): void {
  replacement.startIndex = el.startIndex;
  replacement.endIndex = el.endIndex;
  replaceElement(el, replacement);
}

function param(name: string, value: string): Element {
  return element('ac:parameter', { 'ac:name': name }, [new Text(escapeText(value))]);
}

function macro(name: string, children: ChildNode[] = []): Element {
  return element('ac:structured-macro', { 'ac:name': name }, children);
}

const PANEL_CLASSES: Record<string, string> = {
  'confluence-information-macro-information': 'info',
  'confluence-information-macro-tip': 'tip',
  'confluence-information-macro-warning': 'warning',
  'confluence-information-macro-note': 'note',
};

const PANEL_NAMES: ReadonlySet<string> = new Set(['info', 'tip', 'warning', 'note']);

/** The macro a rendered element stands for: `data-macro-name` (7.x+) or the legacy class names. */
function macroNameOf(el: Element, cls: Set<string>): string | undefined {
  const explicit = el.attribs['data-macro-name'];
  if (explicit !== undefined) return explicit.toLowerCase();
  if (el.name === 'div') {
    if (cls.has('code') && cls.has('panel')) return 'code';
    if (cls.has('preformatted') && cls.has('panel')) return 'noformat';
    if (cls.has('confluence-information-macro')) {
      // `Object.hasOwn`, not a bare lookup: a class named `constructor` would otherwise answer with
      // a function, which is not a macro name and breaks everything downstream that expects a string.
      for (const c of cls) {
        if (Object.hasOwn(PANEL_CLASSES, c)) return PANEL_CLASSES[c] as string;
      }
      return 'info';
    }
    if (cls.has('toc-macro')) return 'toc';
    if (cls.has('expand-container')) return 'expand';
  }
  if (el.name === 'span' && cls.has('jira-issue')) return 'jira';
  if (el.name === 'ul' && cls.has('inline-task-list')) return 'task-list';
  return undefined;
}

function rewriteCode(el: Element, name: string): void {
  const pre = findDescendant(el, (e) => e.name === 'pre');
  if (!pre) {
    swap(el, macro(name));
    return;
  }
  const children: ChildNode[] = [];
  if (name === 'code') {
    const brush = /brush:\s*([^;\s]+)/.exec(
      pre.attribs['data-syntaxhighlighter-params'] ?? ''
    )?.[1];
    if (brush && brush !== 'plain' && brush !== 'text') children.push(param('language', brush));
    const header = findDescendant(el, (e) => classes(e).has('codeHeader'));
    if (header) {
      const title = rawText(header).trim();
      if (title) children.push(element('ac:parameter', { 'ac:name': 'title' }, [new Text(title)]));
    }
  }
  children.push(element('ac:plain-text-body', {}, [new Text(rawText(pre))]));
  swap(el, macro(name === 'noformat' ? 'noformat' : 'code', children));
}

function rewritePanel(el: Element, name: string): void {
  const body = findDescendant(el, (e) => classes(e).has('confluence-information-macro-body'));
  // Older renders, and the `data-macro-name` path, carry the text without that wrapper. Building an
  // empty rich-text body from them dropped the whole panel silently; the generic macro path fences
  // the element instead, which keeps the content and says so with a warning.
  if (!body) {
    swap(el, macro(name));
    return;
  }
  const children: ChildNode[] = [];
  const title = findDescendant(el, (e) => e.name === 'p' && classes(e).has('title'));
  if (title) children.push(element('ac:parameter', { 'ac:name': 'title' }, [...title.children]));
  children.push(element('ac:rich-text-body', {}, [...body.children]));
  swap(el, macro(name, children));
}

function rewriteTaskList(el: Element): void {
  const tasks: ChildNode[] = [];
  for (const li of el.children) {
    if (!isTag(li) || li.name !== 'li') continue;
    const done = classes(li).has('checked');
    tasks.push(
      element('ac:task', {}, [
        element('ac:task-status', {}, [new Text(done ? 'complete' : 'incomplete')]),
        element('ac:task-body', {}, [...li.children]),
      ])
    );
  }
  swap(el, element('ac:task-list', {}, tasks));
}

function rewriteMacro(el: Element, name: string): void {
  if (name === 'code' || name === 'noformat') return rewriteCode(el, name);
  if (PANEL_NAMES.has(name)) return rewritePanel(el, name);
  if (name === 'toc') return swap(el, macro('toc'));
  if (name === 'task-list') return rewriteTaskList(el);
  if (name === 'jira') {
    const key = el.attribs['data-jira-key'];
    if (key) return swap(el, macro('jira', [param('key', key)]));
  }
  // Anything else (expand, status, drawio, …) keeps its rendering only as a fence.
  swap(el, macro(name));
}

const DISPLAY_LINK = /^[^?#]*?\/display\/(~?[^/?#]+)\/([^?#]+)$/;

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '));
  } catch {
    return segment;
  }
}

function filenameOf(el: Element, url: string): string {
  // The view is parsed with `decodeEntities: false`, so the alias is still encoded while the URL
  // fallback is not. Returning both decoded is what lets the caller escape once: `Q&amp;A.png`
  // used to be escaped a second time, and the link text then never matched the filename, so a
  // spurious link body was appended.
  const alias = el.attribs['data-linked-resource-default-alias'];
  if (alias) return decodeAttr(alias);
  const path = url.split(/[?#]/)[0] ?? url;
  return decodePathSegment(path.slice(path.lastIndexOf('/') + 1));
}

function isAttachmentUrl(el: Element, url: string): boolean {
  return (
    el.attribs['data-linked-resource-type'] === 'attachment' ||
    /\/download\/(attachments|thumbnails)\//.test(url)
  );
}

function rewriteAnchor(el: Element): void {
  const href = el.attribs['href'] ?? '';
  const cls = classes(el);
  const username = el.attribs['data-username'];
  if (username && (cls.has('confluence-userlink') || cls.has('user-mention'))) {
    swap(el, element('ac:link', {}, [element('ri:user', { 'ri:username': escapeAttr(username) })]));
    return;
  }
  if (isAttachmentUrl(el, href)) {
    const filename = filenameOf(el, href);
    const text = rawText(el).trim();
    const children: ChildNode[] = [
      element('ri:attachment', { 'ri:filename': escapeAttr(filename) }),
    ];
    if (text && text !== escapeText(filename))
      children.push(element('ac:plain-text-link-body', {}, [new Text(text)]));
    swap(el, element('ac:link', {}, children));
    return;
  }
  const page = DISPLAY_LINK.exec(href);
  if (page && !cls.has('external-link')) {
    const space = decodePathSegment(page[1] as string);
    const title = decodePathSegment(page[2] as string);
    const text = rawText(el).trim();
    const children: ChildNode[] = [
      element('ri:page', {
        'ri:space-key': escapeAttr(space),
        'ri:content-title': escapeAttr(title),
      }),
    ];
    if (text && text !== escapeText(title))
      children.push(element('ac:plain-text-link-body', {}, [new Text(text)]));
    swap(el, element('ac:link', {}, children));
    return;
  }
  for (const name of Object.keys(el.attribs)) {
    if (name !== 'href' && name !== 'title') delete el.attribs[name];
  }
}

function rewriteImage(el: Element): void {
  const cls = classes(el);
  const src = el.attribs['src'] ?? '';
  if (cls.has('emoticon')) {
    const name = el.attribs['data-emoticon-name'] ?? 'unknown';
    swap(el, element('ac:emoticon', { 'ac:name': escapeAttr(name) }));
    return;
  }
  const attribs: Record<string, string> = {};
  for (const dim of ['width', 'height'] as const) {
    const value = el.attribs[dim] ?? el.attribs[`data-${dim}`];
    if (value !== undefined && /^\d+$/.test(value)) attribs[`ac:${dim}`] = value;
  }
  if (el.attribs['alt'] !== undefined) attribs['ac:alt'] = el.attribs['alt'];
  const target = isAttachmentUrl(el, src)
    ? element('ri:attachment', { 'ri:filename': escapeAttr(filenameOf(el, src)) })
    : element('ri:url', { 'ri:value': el.attribs['src'] ?? '' });
  swap(el, element('ac:image', attribs, [target]));
}

const DROP_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'dir',
  'lang',
  'role',
  'tabindex',
  'scope',
  'contenteditable',
]);
const LAYOUT_ELEMENTS: ReadonlySet<string> = new Set(['table', 'colgroup', 'col']);

/** Presentation the renderer adds; the storage reader would otherwise fence every heading and cell. */
function stripAttributes(el: Element): void {
  for (const [name, value] of Object.entries(el.attribs)) {
    if (
      DROP_ATTRIBUTES.has(name) ||
      name.startsWith('data-') ||
      name.startsWith('aria-') ||
      (name === 'title' && el.name !== 'a') ||
      ((name === 'colspan' || name === 'rowspan') && value === '1') ||
      (name === 'style' && LAYOUT_ELEMENTS.has(el.name))
    ) {
      delete el.attribs[name];
    }
  }
}

function rewriteView(doc: Document): void {
  // Macro containers first (outermost wins), then links and images, then the attribute sweep.
  const handled = new Set<Element>();
  for (const el of allElements(doc)) {
    if (handled.has(el)) continue;
    const name = macroNameOf(el, classes(el));
    if (name === undefined) continue;
    for (const inner of allElements(el)) handled.add(inner);
    rewriteMacro(el, name);
  }
  for (const el of allElements(doc)) {
    if (el.name === 'a') rewriteAnchor(el);
    else if (el.name === 'img') rewriteImage(el);
  }
  for (const el of allElements(doc)) {
    if (!el.name.includes(':')) stripAttributes(el);
  }
}
