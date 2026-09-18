import type { BlockContent, Blockquote, Paragraph, Parents, PhrasingContent, Root } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Info, Options as ToMarkdownExtension, State } from 'mdast-util-to-markdown';
import { markdownLineEnding, markdownSpace } from 'micromark-util-character';
import { codes } from 'micromark-util-symbol';
import type {
  Code,
  Extension,
  Previous,
  State as MicromarkState,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';
import type { Node, Parent } from 'unist';

export type AlertKind = 'note' | 'tip' | 'warning' | 'important' | 'caution';
const KINDS: ReadonlySet<string> = new Set(['note', 'tip', 'warning', 'important', 'caution']);

/** Temporary phrasing node for `[!KIND]`; the transform turns the enclosing blockquote into `alert`. */
export interface AlertMarker extends Node {
  type: 'alertMarker';
  kind: AlertKind;
}

/** A GFM alert: `> [!NOTE] Title` followed by the quoted blocks. */
export interface Alert extends Parent {
  type: 'alert';
  kind: AlertKind;
  title?: string | undefined;
  children: BlockContent[];
}

declare module 'mdast' {
  interface PhrasingContentMap {
    alertMarker: AlertMarker;
  }
  interface BlockContentMap {
    alert: Alert;
  }
  interface RootContentMap {
    alertMarker: AlertMarker;
    alert: Alert;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    alertMarker: 'alertMarker';
    alertKind: 'alertKind';
    alertMarkerClose: 'alertMarkerClose';
  }
}

/** Only at the start of a line (after the `> ` prefix); mid-line markers stay text. */
const previous: Previous = function (code) {
  return code === null || markdownLineEnding(code) || markdownSpace(code);
};

const tokenizeAlertMarker: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let kind = '';
  const letters = (code: Code): MicromarkState | undefined => {
    if (code !== null && code >= 65 && code <= 90) {
      kind += String.fromCharCode(code);
      effects.consume(code);
      return letters;
    }
    if (code === codes.rightSquareBracket && KINDS.has(kind.toLowerCase())) {
      effects.exit('alertKind');
      // micromark only consumes into the token entered last, so the closer gets its own token.
      effects.enter('alertMarkerClose');
      effects.consume(code);
      effects.exit('alertMarkerClose');
      effects.exit('alertMarker');
      return ok;
    }
    return nok(code);
  };
  const bang = (code: Code): MicromarkState | undefined => {
    if (code !== codes.exclamationMark) return nok(code);
    effects.consume(code);
    effects.enter('alertKind');
    return letters;
  };
  return (code: Code): MicromarkState | undefined => {
    effects.enter('alertMarker');
    effects.consume(code);
    return bang;
  };
};

export function alertMarker(): Extension {
  return {
    text: {
      [codes.leftSquareBracket]: {
        name: 'alertMarker',
        tokenize: tokenizeAlertMarker,
        previous,
        add: 'before',
      },
    },
  };
}

function isParent(node: Node): node is Parent {
  return Array.isArray((node as Parent).children);
}

/** The marker's paragraph → `{ title, rest }`: title is the rest of the marker line. */
function splitTitle(paragraph: Paragraph): { title?: string; children: PhrasingContent[] } {
  const [, next, ...others] = paragraph.children;
  if (!next) return { children: [] };
  if (next.type === 'break') return { children: others };
  if (next.type !== 'text') return { children: [next, ...others] };
  const newline = next.value.indexOf('\n');
  if (newline === -1) {
    const title = next.value.trim();
    return title ? { title, children: others } : { children: others };
  }
  const title = next.value.slice(0, newline).trim();
  const rest = next.value.slice(newline + 1);
  const children: PhrasingContent[] = rest.length > 0 ? [{ type: 'text', value: rest }] : [];
  return { ...(title ? { title } : {}), children: [...children, ...others] };
}

function toAlert(quote: Blockquote): Alert | undefined {
  const first = quote.children[0];
  if (first?.type !== 'paragraph') return undefined;
  const marker = first.children[0];
  if (marker?.type !== 'alertMarker') return undefined;
  const { title, children } = splitTitle(first);
  const rest = quote.children.slice(1);
  const body = children.length > 0 ? [{ ...first, children }, ...rest] : rest;
  const alert: Alert = { type: 'alert', kind: marker.kind, children: body as BlockContent[] };
  if (title !== undefined) alert.title = title;
  return alert;
}

/** Blockquotes opening with a marker become alerts; any other marker reverts to plain text. */
export function transformAlerts(tree: Root): void {
  const walk = (node: Parent): void => {
    node.children = node.children.map((child) => {
      if (child.type === 'blockquote') {
        const alert = toAlert(child as Blockquote);
        if (alert) {
          walk(alert);
          return alert;
        }
      }
      if (child.type === 'alertMarker') {
        return { type: 'text', value: `[!${(child as AlertMarker).kind.toUpperCase()}]` };
      }
      if (isParent(child)) walk(child);
      return child;
    }) as Parent['children'];
    node.children = mergeText(node.children);
  };
  walk(tree);
}

/** A reverted marker leaves `text, text, text`; canonical markdown has one node. */
function mergeText(children: Parent['children']): Parent['children'] {
  const out: Parent['children'] = [];
  for (const child of children) {
    const last = out[out.length - 1];
    if (child.type === 'text' && last?.type === 'text') {
      const target = last as unknown as { value: string; position?: unknown };
      target.value += (child as unknown as { value: string }).value;
      delete target.position;
    } else {
      out.push(child);
    }
  }
  return out;
}

export function alertFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      alertMarker(token) {
        this.enter({ type: 'alertMarker', kind: 'note' }, token);
      },
    },
    exit: {
      alertKind(token) {
        (this.stack[this.stack.length - 1] as AlertMarker).kind = this.sliceSerialize(
          token
        ).toLowerCase() as AlertKind;
      },
      alertMarker(token) {
        this.exit(token);
      },
    },
    transforms: [transformAlerts],
  };
}

function alertHandler(node: Alert, _parent: Parents | undefined, state: State, info: Info): string {
  const exit = state.enter('blockquote');
  const tracker = state.createTracker(info);
  tracker.move('> ');
  tracker.shift(2);
  const head = `[!${node.kind.toUpperCase()}]${node.title ? ` ${node.title}` : ''}`;
  const flow = state.containerFlow(node, tracker.current());
  // A first paragraph continues the marker line; anything else needs the blank line.
  const separator = node.children[0]?.type === 'paragraph' ? '\n' : '\n\n';
  const value = state.indentLines(flow.length === 0 ? head : `${head}${separator}${flow}`, map);
  exit();
  return value;
}

function map(line: string, _index: number, blank: boolean): string {
  return `>${blank ? '' : ' '}${line}`;
}

export function alertToMarkdown(): ToMarkdownExtension {
  return { handlers: { alert: alertHandler } };
}
