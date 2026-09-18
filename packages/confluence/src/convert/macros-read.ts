import type { Element } from 'domhandler';
import { isCDATA, isTag, isText } from 'domhandler';
import type { BlockContent, RootContent } from 'mdast';
import type { Alert, AlertKind } from './md/alert.js';
import { encodeParams, type Params } from './params.js';
import { readBlocks, textOf, type ReadContext } from './storage-to-mdast.js';
import { attributesOf, decodeText } from './xml/parse.js';

/** `ac:parameter` children as `[name, value]` in source order. */
export function macroParams(el: Element): Params {
  const out: Params = [];
  for (const c of el.children) {
    if (isTag(c) && c.name === 'ac:parameter') {
      const name = c.attribs['ac:name'];
      if (name !== undefined)
        out.push([attributesOf(c).find(([n]) => n === 'ac:name')?.[1] ?? name, textOf(c)]);
    }
  }
  return out;
}

function body(el: Element, name: string): Element | undefined {
  return el.children.find((c): c is Element => isTag(c) && c.name === name);
}

/** CDATA pieces and text of a plain-text body, rejoined exactly. */
function plainText(el: Element): string {
  let out = '';
  for (const c of el.children) {
    if (isText(c)) out += decodeText(c.data);
    else if (isCDATA(c)) out += c.children.map((t) => (isText(t) ? t.data : '')).join('');
  }
  return out;
}

const PANELS: Record<string, AlertKind> = {
  info: 'note',
  tip: 'tip',
  warning: 'warning',
  note: 'important',
};

/**
 * Block-level macro dispatch. Returns `'escalate'` for anything the dialect does not
 * carry, and the caller fences the macro with its exact source.
 */
export function readMacro(el: Element, ctx: ReadContext, path: string): RootContent[] | 'escalate' {
  const name = (el.attribs['ac:name'] ?? '').toLowerCase();
  const params = macroParams(el);
  const rich = body(el, 'ac:rich-text-body');
  const plain = body(el, 'ac:plain-text-body');
  if (name === 'code' || name === 'noformat') {
    if (rich || !plain) return 'escalate';
    const lang = name === 'noformat' ? 'noformat' : params.find(([k]) => k === 'language')?.[1];
    const rest = params.filter(([k]) => !(name === 'code' && k === 'language'));
    // `mdast-util-to-markdown` drops a fence's meta when it has no language, so a `code` macro
    // carrying a title but no `language` would lose the title on the way to markdown and again on
    // the way back, with nothing said about it. Every parameter counts, not just the
    // ones left in `rest`: an empty `<ac:parameter ac:name="language" />` leaves `rest` empty and
    // would be dropped just as quietly.
    if (params.length > 0 && !lang) return 'escalate';
    const node: RootContent = {
      type: 'code',
      lang: lang ?? null,
      meta: rest.length > 0 ? encodeParams(rest) : null,
      value: plainText(plain),
    };
    return [node];
  }
  // `Object.hasOwn`, not `in`: `in` walks the prototype, so a macro named `__proto__` or
  // `constructor` entered this branch with a kind that is not an AlertKind and killed the writer.
  if (Object.hasOwn(PANELS, name)) {
    if (!rich || params.some(([k]) => k !== 'title')) return 'escalate';
    const title = params.find(([k]) => k === 'title')?.[1];
    // The title goes on the `[!KIND]` marker line, which is one line by construction: a newline in
    // it would come back as body text on the next read.
    if (title !== undefined && /[\r\n]/.test(title)) return 'escalate';
    const alert: Alert = {
      type: 'alert',
      kind: PANELS[name] as AlertKind,
      children: readBlocks(rich.children, {
        ...ctx,
        path: `${path}/ac:rich-text-body[1]`,
      }) as BlockContent[],
    };
    if (title !== undefined && title !== '') alert.title = title;
    return [alert];
  }
  if (name === 'toc') {
    if (rich || plain) return 'escalate';
    return [
      {
        type: 'html',
        value: params.length > 0 ? `<!-- toc ${encodeParams(params)} -->` : '<!-- toc -->',
      },
    ];
  }
  return 'escalate';
}
