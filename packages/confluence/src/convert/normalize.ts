import type { ChildNode, Element } from 'domhandler';
import { isCDATA, isComment, isDirective, isTag, isText } from 'domhandler';
import { attributesOf, decodeText, parseStorage } from './xml/parse.js';
import { escapeAttr, escapeText } from './xml/escape.js';

export type CanonNode =
  | { kind: 'element'; name: string; attrs: Array<[string, string]>; children: CanonNode[] }
  | { kind: 'text'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'pi'; value: string };

/** Server-side bookkeeping that changes on every save without changing content. */
export const IGNORED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'ac:macro-id',
  'ac:schema-version',
  'ri:version-at-save',
]);
/** Task identity elements; tasks are matched by position, not id. */
export const IGNORED_ELEMENTS: ReadonlySet<string> = new Set(['ac:task-id', 'ac:task-uuid']);

/** Whitespace-only text between these elements' children is layout, not content. */
export const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([
  'div',
  'blockquote',
  'ul',
  'ol',
  'table',
  'colgroup',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'ac:rich-text-body',
  'ac:structured-macro',
  'ac:macro',
  'ac:link',
  'ac:image',
  'ac:task-list',
  'ac:task',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
]);
/** Elements whose presence makes a `li`/`td`/`th` a block container rather than an inline run. */
export const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
  'div',
  'ac:structured-macro',
  'ac:macro',
  'ac:task-list',
  'ac:layout',
]);
/** Text is kept exactly as written inside these. */
export const VERBATIM: ReadonlySet<string> = new Set([
  'pre',
  'code',
  'ac:plain-text-body',
  'ac:plain-text-link-body',
]);
/** Inline runs: whitespace collapses and is trimmed at the run's edges. */
const PHRASING_CONTAINERS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ac:task-body',
  'ac:link-body',
]);

export type WhitespaceMode = 'block' | 'inline' | 'verbatim';

export function hasBlockChildren(el: Element): boolean {
  return el.children.some((c) => isTag(c) && BLOCK_ELEMENTS.has(c.name));
}

/** The whitespace mode an element's children are read in; shared with the reader. */
export function modeOf(el: Element, parentMode: WhitespaceMode): WhitespaceMode {
  if (parentMode === 'verbatim' || VERBATIM.has(el.name)) return 'verbatim';
  if (BLOCK_CONTAINERS.has(el.name)) return 'block';
  if (PHRASING_CONTAINERS.has(el.name)) return 'inline';
  if (el.name === 'li' || el.name === 'td' || el.name === 'th') {
    return hasBlockChildren(el) ? 'block' : 'inline';
  }
  return parentMode;
}

function canonChildren(nodes: ChildNode[], mode: WhitespaceMode): CanonNode[] {
  const out: CanonNode[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      const value = decodeText(node.data);
      if (mode === 'block' && value.trim() === '') continue;
      out.push({ kind: 'text', value });
      continue;
    }
    if (isCDATA(node)) {
      const raw = node.children.map((c) => (isText(c) ? c.data : '')).join('');
      out.push({ kind: 'text', value: raw });
      continue;
    }
    if (isComment(node)) {
      out.push({ kind: 'comment', value: node.data });
      continue;
    }
    if (isDirective(node)) {
      // domhandler keeps the `?` marks in the data (`?pi x?`); the canonical form stores the inside.
      out.push({ kind: 'pi', value: node.data.replace(/^\?/, '').replace(/\?$/, '') });
      continue;
    }
    if (isTag(node)) {
      if (IGNORED_ELEMENTS.has(node.name)) continue;
      const childMode = modeOf(node, mode);
      let children = canonChildren(node.children, childMode);
      if (childMode === 'inline' && mode !== 'inline') children = collapseRun(children);
      if (node.name === 'ac:structured-macro' || node.name === 'ac:macro') {
        children = sortMacroChildren(children);
      }
      out.push({
        kind: 'element',
        name: node.name,
        attrs: attributesOf(node)
          .filter(([name]) => !IGNORED_ATTRIBUTES.has(name))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        children,
      });
    }
  }
  return mergeText(out);
}

function mergeText(nodes: CanonNode[]): CanonNode[] {
  const out: CanonNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.kind === 'text' && node.value === '') continue;
    if (node.kind === 'text' && last?.kind === 'text') last.value += node.value;
    else out.push(node);
  }
  return out;
}

/** Text nodes of an inline run in document order, skipping verbatim subtrees. */
function runTexts(nodes: CanonNode[], into: Array<{ kind: 'text'; value: string }>): void {
  for (const node of nodes) {
    if (node.kind === 'text') into.push(node);
    else if (node.kind === 'element' && !VERBATIM.has(node.name)) runTexts(node.children, into);
  }
}

const HOIST_EDGES: ReadonlySet<string> = new Set(['strong', 'em', 'b', 'i', 's', 'del', 'strike']);

function edgeText(nodes: CanonNode[], side: 'first' | 'last'): CanonNode | undefined {
  const node = side === 'first' ? nodes[0] : nodes[nodes.length - 1];
  if (!node) return undefined;
  if (node.kind === 'element' && !VERBATIM.has(node.name) && node.children.length > 0) {
    return edgeText(node.children, side);
  }
  return node;
}

/** `<strong> x </strong>` ≡ ` <strong>x</strong> `: whitespace at the edges belongs to the parent. */
function hoistEdges(nodes: CanonNode[]): CanonNode[] {
  const out: CanonNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'element' && !VERBATIM.has(node.name)) {
      node.children = hoistEdges(node.children);
      if (HOIST_EDGES.has(node.name)) {
        const first = edgeText(node.children, 'first');
        if (first?.kind === 'text' && first.value.startsWith(' ')) {
          first.value = first.value.slice(1);
          out.push({ kind: 'text', value: ' ' });
        }
        out.push(node);
        const last = edgeText(node.children, 'last');
        if (last?.kind === 'text' && last.value.endsWith(' ')) {
          last.value = last.value.slice(0, -1);
          out.push({ kind: 'text', value: ' ' });
        }
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

/** Collapse whitespace runs inside an inline run and trim the run's two edges. */
function collapseRun(input: CanonNode[]): CanonNode[] {
  const texts: Array<{ kind: 'text'; value: string }> = [];
  runTexts(input, texts);
  for (const t of texts) t.value = t.value.replace(/[ \t\r\n]+/g, ' ');
  const children = mergeText(hoistEdges(input));
  texts.length = 0;
  runTexts(children, texts);
  for (const t of texts) t.value = t.value.replace(/[ \t\r\n]+/g, ' ');
  const first = texts[0];
  if (first) first.value = first.value.replace(/^ /, '');
  const last = texts[texts.length - 1];
  if (last) last.value = last.value.replace(/ $/, '');
  return dropEmptyText(children);
}

function dropEmptyText(nodes: CanonNode[]): CanonNode[] {
  const out: CanonNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text' && node.value === '') continue;
    if (node.kind === 'element') node.children = dropEmptyText(node.children);
    out.push(node);
  }
  return mergeText(out);
}

/** `ac:parameter` children first, by name; the rest keep their order (stable). */
function sortMacroChildren(children: CanonNode[]): CanonNode[] {
  const isParam = (c: CanonNode): boolean => c.kind === 'element' && c.name === 'ac:parameter';
  const nameOf = (c: CanonNode): string =>
    c.kind === 'element' ? (c.attrs.find(([n]) => n === 'ac:name')?.[1] ?? '') : '';
  const params = children.filter(isParam).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return [...params, ...children.filter((c) => !isParam(c))];
}

export function toCanonicalTree(src: string): CanonNode[] {
  const { doc } = parseStorage(src);
  return canonChildren(doc.children, 'block');
}

export function serializeCanonical(nodes: CanonNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += escapeText(node.value);
        break;
      case 'comment':
        out += `<!--${node.value}-->`;
        break;
      case 'pi':
        out += `<?${node.value}?>`;
        break;
      case 'element': {
        const attrs = node.attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join('');
        out +=
          node.children.length === 0
            ? `<${node.name}${attrs}/>`
            : `<${node.name}${attrs}>${serializeCanonical(node.children)}</${node.name}>`;
      }
    }
  }
  return out;
}

/**
 * Canonical storage: the same page written by the editor, by `mdastToStorage` or pretty-printed
 * compares equal, while real content differences do not.
 */
export function normalizeStorage(src: string): string {
  return serializeCanonical(toCanonicalTree(src));
}
