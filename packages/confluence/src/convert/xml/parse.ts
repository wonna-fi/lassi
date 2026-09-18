import type { ChildNode, Document, Element, ParentNode } from 'domhandler';
import { hasChildren, isDirective, isTag } from 'domhandler';
import { decodeHTML, decodeHTMLAttribute, DecodingMode } from 'entities';
import { parseDocument } from 'htmlparser2';

export interface ParsedStorage {
  src: string;
  doc: Document;
}

/** Elements Confluence writes self-closed; repaired if a hand-written page left them open. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'col']);

/**
 * Storage format as an XML document with source offsets. Entities stay undecoded in the tree so a
 * node's source slice is byte-exact (raw fences are slices); `decodeText`/`decodeAttr` decode on
 * demand with the full HTML5 table, because storage uses `&nbsp;`, `&rsquo;` and friends.
 */
export function parseStorage(src: string): ParsedStorage {
  const doc = parseDocument(src, {
    xmlMode: true,
    decodeEntities: false,
    withStartIndices: true,
    withEndIndices: true,
  });
  repairVoids(doc);
  return { src, doc };
}

/** In XML mode an unclosed `<br>` swallows its siblings; move them back out. */
function repairVoids(parent: ParentNode): void {
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i] as ChildNode;
    if (!isTag(child)) continue;
    if (VOID_ELEMENTS.has(child.name) && child.children.length > 0) {
      const moved = child.children;
      child.children = [];
      for (const node of moved) node.parent = parent;
      parent.children.splice(i + 1, 0, ...moved);
    }
    if (hasChildren(child)) repairVoids(child);
  }
}

function offsets(src: string, node: ChildNode): { start: number; end: number } {
  const start = node.startIndex ?? 0;
  let end = node.endIndex ?? start - 1;
  // htmlparser2 ends a processing instruction at its `?`, so the slice would drop the closing `>`
  // and the fence, written back, would swallow whatever follows it.
  if (isDirective(node) && src[end] !== '>') {
    const close = src.indexOf('>', end);
    if (close !== -1) end = close;
  }
  return { start, end };
}

/** The exact source of one node, inclusive of its own tags. */
export function sliceSource(src: string, node: ChildNode): string {
  const { start, end } = offsets(src, node);
  return src.slice(start, end + 1);
}

/** The exact source from `first` through `last` (a maximal inline run under one parent). */
export function sliceRange(src: string, first: ChildNode, last: ChildNode): string {
  return src.slice(offsets(src, first).start, offsets(src, last).end + 1);
}

export function decodeText(raw: string): string {
  return decodeHTML(raw, DecodingMode.Strict);
}

export function decodeAttr(raw: string): string {
  return decodeHTMLAttribute(raw);
}

export function attributesOf(el: Element): Array<[string, string]> {
  return Object.entries(el.attribs).map(([name, value]) => [name, decodeAttr(value)]);
}
