import type { Mention } from '@wonna/lassi-core';
import type { Delete, Emphasis, PhrasingContent, Strong } from 'mdast';
import {
  basename,
  COLOR_CLOSE,
  COLOR_OPEN,
  COLOR_VALUE,
  ESCAPABLE,
  findCloser,
  IMAGE_BODY,
  IMAGE_PARAM,
  isEmphasisOpener,
  trimUrl,
  URL_START,
  WORD,
} from '../syntax.js';
import { parseMacroHeader } from './macros.js';

export interface InlineContext {
  inTableCell?: boolean;
}

export interface InlineResult {
  nodes: PhrasingContent[];
  /** Wiki constructs with no markdown equivalent; the caller fences the whole block when non-empty. */
  unsupported: string[];
}

/**
 * Jira image parameters (`|width=1136,height=560`, `|thumbnail`, `|align=right, vspace=4`) travel
 * in the markdown image title as space-separated words : pasted screenshots carry
 * width/height in every modern Jira. `null` means a value the title cannot carry, which keeps the
 * block raw.
 */
function imageTitle(params: string | undefined): string | undefined | null {
  if (params === undefined) return undefined;
  const words: string[] = [];
  for (const part of params.split(',')) {
    const word = part.trim();
    if (word === 'thumbnail' || IMAGE_PARAM.test(word)) words.push(word);
    else return null;
  }
  return words.length > 0 ? words.join(' ') : null;
}
/**
 * A hard break only survives the markdown round trip in the middle of a paragraph: at the end of a
 * block it stringifies to a dangling backslash that re-parses as a literal `\`, and gfm-table
 * flattens it to a space inside a cell. Both places keep the break as inline HTML, which the
 * serialiser turns back into `\\`.
 */
const HTML_BREAK: PhrasingContent = { type: 'html', value: '<br>' };

/** Replaces a trailing break, which markdown cannot carry at the end of a block. */
export function breakSafeRun(nodes: PhrasingContent[]): PhrasingContent[] {
  const last = nodes[nodes.length - 1];
  if (last?.type !== 'break') return nodes;
  return [...nodes.slice(0, -1), { ...HTML_BREAK }];
}

export function parseInline(text: string, ctx: InlineContext = {}): InlineResult {
  const nodes: PhrasingContent[] = [];
  const unsupported: string[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer.length > 0) nodes.push({ type: 'text', value: buffer });
    buffer = '';
  };
  const push = (node: PhrasingContent): void => {
    flush();
    nodes.push(node);
  };

  const emphasis = (marker: string, at: number): boolean => {
    if (!isEmphasisOpener(text, at, marker)) return false;
    const close = findCloser(text, at + marker.length, marker);
    if (close === -1) return false;
    const inner = text.slice(at + marker.length, close);
    if (marker === '*' || marker === '_' || marker === '-') {
      const sub = parseInline(inner, ctx);
      unsupported.push(...sub.unsupported);
      const node: Strong | Emphasis | Delete =
        marker === '*'
          ? { type: 'strong', children: sub.nodes }
          : marker === '_'
            ? { type: 'emphasis', children: sub.nodes }
            : { type: 'delete', children: sub.nodes };
      push(node);
    } else {
      unsupported.push(text.slice(at, close + marker.length));
      buffer += text.slice(at, close + marker.length);
    }
    i = close + marker.length;
    return true;
  };

  while (i < text.length) {
    const ch = text[i] as string;
    const rest = text.slice(i);

    if (ch === '\n') {
      push(ctx.inTableCell ? { ...HTML_BREAK } : { type: 'break' });
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\\') {
        push(ctx.inTableCell ? { ...HTML_BREAK } : { type: 'break' });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    if (rest.startsWith('{{')) {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        let value = text.slice(i + 2, end);
        if (ctx.inTableCell) value = value.replace(/&#124;/g, '|');
        push({ type: 'inlineCode', value });
        i = end + 2;
        continue;
      }
    }

    if (ch === '{') {
      const intra = /^\{([*_-])\}/.exec(rest);
      if (intra) {
        const marker = intra[1] as string;
        const closeTag = `{${marker}}`;
        const close = text.indexOf(closeTag, i + 3);
        if (close !== -1 && close > i + 3) {
          const sub = parseInline(text.slice(i + 3, close), ctx);
          unsupported.push(...sub.unsupported);
          const node: Strong | Emphasis | Delete =
            marker === '*'
              ? { type: 'strong', children: sub.nodes }
              : marker === '_'
                ? { type: 'emphasis', children: sub.nodes }
                : { type: 'delete', children: sub.nodes };
          push(node);
          i = close + 3;
          continue;
        }
      }
      // `{color:red}text{color}` ↔ `<span style="color:red">text</span>`. The body is
      // trimmed: canonical markdown cannot carry a hard break right before the closing tag.
      const color = COLOR_OPEN.exec(rest);
      if (color) {
        const value = (color[1] as string).trim();
        const closeAt = COLOR_CLOSE.exec(text.slice(i + color[0].length));
        if (COLOR_VALUE.test(value) && closeAt) {
          const bodyStart = i + color[0].length;
          const body = text.slice(bodyStart, bodyStart + closeAt.index).trim();
          if (body.length > 0) {
            const sub = parseInline(body, ctx);
            unsupported.push(...sub.unsupported);
            push({ type: 'html', value: `<span style="color:${value}">` });
            nodes.push(...sub.nodes, { type: 'html', value: '</span>' });
            i = bodyStart + closeAt.index + closeAt[0].length;
            continue;
          }
        }
      }
      // Any other macro, or a colour opener without a usable value, closer or body: unsupported,
      // so the whole block stays a raw fence.
      const macro = parseMacroHeader(text, i);
      if (macro) {
        unsupported.push(macro.raw);
        buffer += macro.raw;
        i += macro.raw.length;
        continue;
      }
    }

    if (ch === '[') {
      const mention = /^\[~([^\]|\s]+)\]/.exec(rest);
      if (mention) {
        const node: Mention = { type: 'mention', username: mention[1] as string };
        push(node);
        i += mention[0].length;
        continue;
      }
      const attachment = /^\[\^([^\]|\n]+)\]/.exec(rest);
      if (attachment) {
        const file = attachment[1] as string;
        push({
          type: 'link',
          url: `attachment:${file}`,
          children: [{ type: 'text', value: file }],
        });
        i += attachment[0].length;
        continue;
      }
      const piped = /^\[([^\]|\n]*)\|([^\]\n]+)\]/.exec(rest);
      if (piped) {
        const label = (piped[1] as string).trim();
        const target = piped[2] as string;
        const bar = target.indexOf('|');
        if (bar !== -1) {
          unsupported.push(piped[0]);
          buffer += piped[0];
        } else {
          const trimmed = target.trim();
          // `[label|^file.txt]` is the labelled form of the attachment link `[^file.txt]`.
          const url = trimmed.startsWith('^') ? `attachment:${trimmed.slice(1).trim()}` : trimmed;
          const labelText = label.length > 0 ? label : trimmed;
          push({ type: 'link', url, children: [{ type: 'text', value: labelText }] });
        }
        i += piped[0].length;
        continue;
      }
      const bare = /^\[((?:https?|mailto|ftp|file|ssh):[^\]\s]+)\]/.exec(rest);
      if (bare) {
        const url = bare[1] as string;
        push({ type: 'link', url, children: [{ type: 'text', value: url }] });
        i += bare[0].length;
        continue;
      }
    }

    if (ch === '!') {
      const image = /^!([^!\n]+?)!/.exec(rest);
      if (image) {
        const inner = image[1] as string;
        const bar = inner.indexOf('|');
        const body = (bar === -1 ? inner : inner.slice(0, bar)).trim();
        const params = bar === -1 ? undefined : inner.slice(bar + 1).trim();
        if (IMAGE_BODY.test(body)) {
          const title = imageTitle(params);
          if (title === null) {
            unsupported.push(image[0]);
            buffer += image[0];
          } else {
            const url = /^https?:\/\//.test(body) ? body : `attachment:${body}`;
            const node: PhrasingContent = {
              type: 'image',
              url,
              alt: basename(body),
              ...(title === undefined ? {} : { title }),
            };
            push(node);
          }
          i += image[0].length;
          continue;
        }
      }
    }

    if (ch === '*' || ch === '_' || ch === '-' || ch === '+' || ch === '^' || ch === '~') {
      if (emphasis(ch, i)) continue;
    }
    if (rest.startsWith('??')) {
      if (emphasis('??', i)) continue;
    }

    if (ch === 'h' && (rest.startsWith('http://') || rest.startsWith('https://'))) {
      const prev = text[i - 1];
      if (prev === undefined || !WORD.test(prev)) {
        const m = URL_START.exec(rest);
        if (m) {
          const url = trimUrl(m[0]);
          push({ type: 'link', url, children: [{ type: 'text', value: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if (ctx.inTableCell && rest.startsWith('&#124;')) {
      buffer += '|';
      i += 6;
      continue;
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return { nodes, unsupported };
}
