import { LassiError, type Mention } from '@wonna/lassi-core';
import type { Definition, Delete, Emphasis, Image, Link, PhrasingContent, Strong } from 'mdast';
import { toString } from 'mdast-util-to-string';
import {
  BQ,
  COLOR_VALUE,
  HEADING,
  IMAGE_BODY,
  IMAGE_PARAM,
  OPENER_BEFORE,
  trimUrl,
  URL_START,
  WORD,
} from '../syntax.js';
import { escapeEmphasis, escapeStructural } from './escape.js';
import type { Warnings } from './warnings.js';

/** Where a phrasing run lives; it decides break forms and which line-start guards apply. */
export type Container = 'paragraph' | 'heading' | 'listItem' | 'cell' | 'emphasis' | 'color';

export interface RunContext {
  container: Container;
  closerMarkers: readonly string[];
  warnings: Warnings;
  definitions: ReadonlyMap<string, Definition>;
}

type EmphasisMarker = '*' | '_' | '-';
type BreakForm = '\\\\' | '\n';

type Item =
  | { kind: 'text'; value: string }
  | { kind: 'markup'; value: string }
  | { kind: 'break'; form?: BreakForm }
  | { kind: 'emphasis'; node: Strong | Emphasis | Delete; marker: EmphasisMarker };

const SPAN_OPEN = /^<span\s+style\s*=\s*"\s*color\s*:\s*([^";]+?)\s*;?\s*"\s*>$/i;
const SPAN_CLOSE = /^<\/span\s*>$/i;
const BR = /^<br\s*\/?>$/i;
const HTML_HINT =
  'use markdown syntax, <span style="color:…">…</span> for colour, or a ```jira fence';

function unsupported(message: string, hint?: string): LassiError {
  return new LassiError('validation', message, hint === undefined ? {} : { hint });
}

/** Phrasing content → one wiki text run (one or more wiki lines, joined by `\n`). */
export function renderRun(nodes: PhrasingContent[], ctx: RunContext): string {
  const items = flatten(nodes, ctx);
  decideBreaks(items, ctx.container);
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (item.kind !== 'emphasis') continue;
    items[i] = {
      kind: 'markup',
      value: emitEmphasis(item.node, item.marker, charBefore(items, i), charAfter(items, i), ctx),
    };
  }
  return assemble(items, ctx);
}

function lastCharOf(items: Item[]): string | undefined {
  const last = items[items.length - 1];
  if (!last) return undefined;
  if (last.kind === 'text' || last.kind === 'markup') return last.value[last.value.length - 1];
  return undefined;
}

function flatten(nodes: PhrasingContent[], ctx: RunContext): Item[] {
  const items: Item[] = [];
  const pushText = (value: string): void => {
    const last = items[items.length - 1];
    if (last?.kind === 'text') last.value += value;
    else items.push({ kind: 'text', value });
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as PhrasingContent;
    switch (node.type) {
      case 'text':
        // A soft line break is a space in GFM; Jira would render the newline as a break.
        pushText(node.value.replace(/[ \t]*\n[ \t]*/g, ' '));
        break;
      case 'break':
        items.push({ kind: 'break' });
        break;
      case 'inlineCode':
        items.push({ kind: 'markup', value: inlineCode(node.value, ctx) });
        break;
      case 'strong':
        items.push({ kind: 'emphasis', node, marker: '*' });
        break;
      case 'emphasis':
        items.push({ kind: 'emphasis', node, marker: '_' });
        break;
      case 'delete':
        items.push({ kind: 'emphasis', node, marker: '-' });
        break;
      case 'link':
        items.push({ kind: 'markup', value: link(node, lastCharOf(items), ctx) });
        break;
      case 'image':
        items.push({ kind: 'markup', value: image(node) });
        break;
      case 'linkReference': {
        const def = resolveDefinition(node.identifier, node.label, ctx);
        const resolved: Link = { type: 'link', url: def.url, children: node.children };
        if (def.title != null) resolved.title = def.title;
        items.push({ kind: 'markup', value: link(resolved, lastCharOf(items), ctx) });
        break;
      }
      case 'imageReference': {
        const def = resolveDefinition(node.identifier, node.label, ctx);
        const resolved: Image = { type: 'image', url: def.url, alt: node.alt ?? null };
        if (def.title != null) resolved.title = def.title;
        items.push({ kind: 'markup', value: image(resolved) });
        break;
      }
      case 'html': {
        if (BR.test(node.value)) {
          items.push({ kind: 'break' });
          break;
        }
        const open = SPAN_OPEN.exec(node.value);
        if (open) {
          const close = findSpanClose(nodes, i);
          items.push({
            kind: 'markup',
            value: colour((open[1] as string).trim(), nodes.slice(i + 1, close), ctx),
          });
          i = close;
          break;
        }
        if (SPAN_CLOSE.test(node.value)) {
          throw unsupported('</span> without a matching <span style="color:…"> in the same block');
        }
        throw unsupported(
          `inline HTML is not supported in Jira wiki markup: ${node.value.slice(0, 40)}`,
          HTML_HINT
        );
      }
      case 'footnoteReference':
        throw unsupported('footnotes are not supported in Jira wiki markup');
      default: {
        if (node.type === 'mention') {
          items.push({ kind: 'markup', value: `[~${(node as Mention).username}]` });
          break;
        }
        throw unsupported(`unsupported markdown node: ${(node as { type: string }).type}`);
      }
    }
  }
  return items;
}

function findSpanClose(nodes: PhrasingContent[], openAt: number): number {
  for (let j = openAt + 1; j < nodes.length; j++) {
    const node = nodes[j] as PhrasingContent;
    if (node.type !== 'html') continue;
    if (SPAN_CLOSE.test(node.value)) return j;
    if (SPAN_OPEN.test(node.value)) throw unsupported('colour spans cannot be nested');
  }
  throw unsupported('<span style="color:…"> without a matching </span> in the same block');
}

function colour(value: string, inner: PhrasingContent[], ctx: RunContext): string {
  if (!COLOR_VALUE.test(value)) {
    throw unsupported(
      `colour "${value}" has no Jira wiki form`,
      'use a colour name, #rgb or #rrggbb'
    );
  }
  const body = renderRun(inner, { ...ctx, container: 'color' }).trim();
  if (body.length === 0) throw unsupported('empty colour span');
  return `{color:${value}}${body}{color}`;
}

function resolveDefinition(
  identifier: string,
  label: string | null | undefined,
  ctx: RunContext
): Definition {
  const def = ctx.definitions.get(identifier);
  if (!def) throw unsupported(`reference [${label ?? identifier}] has no definition`);
  return def;
}

/** Hard breaks are bare newlines only where the parser would read the next line as a continuation. */
function decideBreaks(items: Item[], container: Container): void {
  const continuation = container === 'paragraph' || container === 'listItem';
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    if (item.kind !== 'break') continue;
    item.form = continuation ? breakForm(items, i) : '\\\\';
  }
}

function breakForm(items: Item[], at: number): BreakForm {
  const prev = items[at - 1];
  const next = items[at + 1];
  if (!prev || !next || prev.kind === 'break' || next.kind === 'break') return '\\\\';
  // Continuation lines are trimmed on read, so boundary whitespace survives only inline.
  if (prev.kind === 'text' && /\s$/.test(prev.value)) return '\\\\';
  if (next.kind === 'text' && /^\s/.test(next.value)) return '\\\\';
  let nextRaw = '';
  for (let j = at + 1; j < items.length; j++) {
    const item = items[j] as Item;
    if (item.kind === 'break') break;
    nextRaw += item.kind === 'emphasis' ? '*' : item.value;
  }
  // `h1.` and `bq.` have no escape, so such a line must not start a wiki line.
  if (HEADING.test(nextRaw.trimStart()) || BQ.test(nextRaw.trimStart())) return '\\\\';
  return '\n';
}

function charBefore(items: Item[], at: number): string | undefined {
  const prev = items[at - 1];
  if (!prev) return undefined;
  if (prev.kind === 'break') return prev.form === '\\\\' ? '\\' : undefined;
  if (prev.kind === 'emphasis') return '*';
  return prev.value[prev.value.length - 1];
}

function charAfter(items: Item[], at: number): string | undefined {
  const next = items[at + 1];
  if (!next) return undefined;
  if (next.kind === 'break') return undefined;
  if (next.kind === 'emphasis') return '*';
  return next.value[0];
}

/**
 * `*b*` when the neighbours satisfy Jira's opener/closer rules, otherwise Jira's intra-word form
 * `{*}b{*}`; whitespace at the edges moves outside the markers.
 */
function emitEmphasis(
  node: Strong | Emphasis | Delete,
  marker: EmphasisMarker,
  before: string | undefined,
  after: string | undefined,
  ctx: RunContext
): string {
  const inner = renderRun(node.children, {
    ...ctx,
    container: 'emphasis',
    closerMarkers: [...ctx.closerMarkers, marker],
  });
  const core = inner.trim();
  if (core.length === 0) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const trail = inner.slice(inner.trimEnd().length);
  const leftNeighbour = lead.length > 0 ? ' ' : before;
  const rightNeighbour = trail.length > 0 ? ' ' : after;
  const plain =
    (leftNeighbour === undefined || OPENER_BEFORE.test(leftNeighbour)) &&
    (rightNeighbour === undefined || !WORD.test(rightNeighbour)) &&
    core[0] !== marker;
  if (plain) return `${lead}${marker}${core}${marker}${trail}`;
  const tag = `{${marker}}`;
  if (core.includes(tag)) {
    throw unsupported(`emphasis next to a word cannot contain "${tag}" in Jira wiki markup`);
  }
  return `${lead}${tag}${core}${tag}${trail}`;
}

/** Everything up to the next bare-newline break: one wiki line, as segments. */
function wikiLinesOf(items: Item[]): Item[][] {
  const lines: Item[][] = [[]];
  for (const item of items) {
    if (item.kind === 'break' && item.form === '\n') lines.push([]);
    else (lines[lines.length - 1] as Item[]).push(item);
  }
  return lines;
}

function assemble(items: Item[], ctx: RunContext): string {
  const guards = ctx.container === 'paragraph' || ctx.container === 'listItem';
  const lines = wikiLinesOf(items);
  return lines
    .map((segments, lineIndex) => {
      const base = {
        lineStart: guards,
        paragraphStart: ctx.container === 'paragraph' && lineIndex === 0,
        inTableCell: ctx.container === 'cell',
        closerMarkers: ctx.closerMarkers,
        warnings: ctx.warnings,
      };
      // Pass A on every text segment first, so pass B can look ahead at the escaped line.
      const structural: string[] = [];
      let out = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] as Item;
        const value = pieceValue(seg);
        if (seg.kind === 'text') {
          const rest = segments
            .slice(i + 1)
            .map(pieceValue)
            .join('');
          structural[i] = escapeStructural(value, { ...base, out, rest });
        } else {
          structural[i] = value;
        }
        out += structural[i] as string;
      }
      let line = '';
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] as Item;
        const piece = structural[i] as string;
        if (seg.kind !== 'text') {
          line += piece;
          continue;
        }
        const rest = structural.slice(i + 1).join('');
        line += escapeEmphasis(piece, { ...base, out: line, rest });
      }
      return line;
    })
    .join('\n');
}

function pieceValue(item: Item): string {
  if (item.kind === 'break') return '\\\\';
  if (item.kind === 'emphasis') throw new Error('emphasis item not rendered');
  return item.value;
}

function inlineCode(value: string, ctx: RunContext): string {
  if (value.includes('}}') || value.endsWith('}')) {
    throw unsupported(
      'inline code containing "}}" or ending with "}" has no Jira wiki form',
      'use a fenced code block'
    );
  }
  return `{{${ctx.container === 'cell' ? value.replace(/\|/g, '&#124;') : value}}}`;
}

function link(node: Link, before: string | undefined, ctx: RunContext): string {
  const label = toString(node);
  if (node.title) {
    ctx.warnings.add(
      'link-title-dropped',
      `link title "${node.title}" has no Jira wiki form`,
      node
    );
  }
  if (node.children.some((c) => c.type !== 'text')) {
    ctx.warnings.add(
      'link-label-flattened',
      `formatting inside the link "${label}" is dropped`,
      node
    );
  }
  const only = node.children.length === 1 ? node.children[0] : undefined;
  const single = only?.type === 'text' ? only.value : undefined;
  const autolink =
    single !== undefined &&
    !node.title &&
    (node.url === single || node.url === `mailto:${single}` || node.url === `http://${single}`);
  if (autolink && (before === undefined || !WORD.test(before))) {
    const isUrl = node.url === single;
    const whole = URL_START.exec(single)?.[0] === single && trimUrl(single) === single;
    if (!isUrl || whole) return single;
  }
  // Only `]` and `|` end the construct. Spaces are ordinary in an attachment name (a pasted
  // screenshot is `Screen Shot 2026.png`), and the reader produces exactly those links, so
  // rejecting them would make an issue the tool itself read impossible to write back.
  if (/[\]|\n]/.test(label) || /[\]|\n]/.test(node.url)) {
    throw unsupported(`link "${label}" cannot be written: labels and URLs may not contain ] or |`);
  }
  if (node.url.startsWith('attachment:')) {
    const file = node.url.slice('attachment:'.length);
    return label === file ? `[^${file}]` : `[${label}|^${file}]`;
  }
  return `[${label}|${node.url}]`;
}

function image(node: Image): string {
  let body: string;
  if (node.url.startsWith('attachment:')) {
    body = node.url.slice('attachment:'.length);
    if (!IMAGE_BODY.test(body) || body.includes('!')) {
      throw unsupported(
        `attachment image "${body}" needs a file name with an extension and no "!" or "|"`
      );
    }
  } else if (/^https?:\/\//.test(node.url) && !/[\s!|]/.test(node.url)) {
    body = node.url;
  } else {
    throw unsupported(
      `image "${node.url}" has no Jira wiki form`,
      'use attachment:<file.png> or an http(s) URL'
    );
  }
  const words = node.title ? node.title.trim().split(/\s+/) : [];
  for (const word of words) {
    if (word !== 'thumbnail' && !IMAGE_PARAM.test(word)) {
      throw unsupported(
        `image parameter "${word}" has no Jira wiki form`,
        'use "thumbnail" or key=value words in the title, e.g. "width=1136 height=560"'
      );
    }
  }
  return `!${body}${words.length > 0 ? `|${words.join(',')}` : ''}!`;
}
