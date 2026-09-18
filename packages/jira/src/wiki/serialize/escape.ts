import { LassiError } from '@wonna/lassi-core';
import {
  BQ,
  ESCAPABLE,
  findCloser,
  HEADING,
  IMAGE_BODY,
  isSpace,
  LIST_ITEM,
  MACRO_OPEN,
  OPENER_BEFORE,
  RULE,
  WORD,
} from '../syntax.js';
import type { Warnings } from './warnings.js';

export interface EscapeContext {
  /** The wiki line rendered so far: what the parser sees before this text. */
  out: string;
  /** The rest of the line after this text (later text unescaped, markup rendered). */
  rest: string;
  /** Block-start guards apply: this wiki line is a paragraph or list-continuation line. */
  lineStart: boolean;
  /** Only a paragraph's first line can start with `h1.` / `bq.`, which have no escape. */
  paragraphStart: boolean;
  inTableCell: boolean;
  /** Markers of the enclosing emphasis nodes; a closer-position occurrence would end them early. */
  closerMarkers: readonly string[];
  warnings: Warnings;
}

/** The parser's image span; the body test below is Jira's stricter rendering rule on top. */
const IMAGE_SPAN = /^!([^!\n]+?)!/;
/** The parser's piped link `[label|target]`; the label may start with a space. */
const PIPED_LINK = /^\[[^\]|\n]*\|[^\]\n]+\]/;
/** The row splitter treats `!x…!` as one span even across `|`, so in a cell every such start is escaped. */
const CELL_IMAGE_START = /^![^!|\s]/;
const EMPHASIS_MARKERS: ReadonlySet<string> = new Set(['*', '_', '-', '+', '^', '~']);

function isOpener(prev: string | undefined, next: string | undefined, marker: string): boolean {
  if (prev !== undefined && !OPENER_BEFORE.test(prev)) return false;
  if (next === undefined || isSpace(next) || next === marker[0]) return false;
  return true;
}

function prevOf(result: string, out: string): string | undefined {
  if (result.length > 0) return result[result.length - 1];
  if (out.length > 0) return out[out.length - 1];
  return undefined;
}

/**
 * Pass A: structural escapes whose decisions do not depend on later escaping — line-start guards,
 * backslashes, macro headers, anchor-style brackets, image spans and cell pipes. `ctx.rest` may be
 * raw text here because these rules only look for the presence of `]`, `}` or `!` further on.
 */
export function escapeStructural(text: string, ctx: EscapeContext): string {
  let result = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k] as string;
    const remainder = text.slice(k + 1) + ctx.rest;
    const next = remainder[0];
    const prev = prevOf(result, ctx.out);

    if (ctx.lineStart && prev === undefined) {
      const line = ch + remainder;
      if (ctx.paragraphStart && (HEADING.test(line) || BQ.test(line))) {
        throw new LassiError(
          'validation',
          `a paragraph cannot start with "${line.slice(0, line.indexOf('.') + 1)}" in Jira wiki markup`,
          { hint: 'put it in inline code or a ```jira fence' }
        );
      }
      if ((ch === '*' || ch === '#' || ch === '-') && (LIST_ITEM.test(line) || RULE.test(line))) {
        result += `\\${ch}`;
        continue;
      }
      if (ch === '|') {
        result += '\\|';
        continue;
      }
    }

    switch (ch) {
      case '\\': {
        const lastInCell = ctx.inTableCell && remainder.length === 0;
        if ((next !== undefined && (next === '\\' || ESCAPABLE.has(next))) || lastInCell) {
          ctx.warnings.add(
            'backslash-entity',
            'a backslash before a special character is written as &#92; and does not round-trip'
          );
          result += '&#92;';
        } else {
          result += ch;
        }
        break;
      }
      case '{':
        result +=
          next === '{' || /^[*_-]\}/.test(remainder) || MACRO_OPEN.test(ch + remainder)
            ? '\\{'
            : ch;
        break;
      case '[':
        // Jira-safety superset of the parser's four link forms: `[anything]` links to an anchor.
        // Inside a cell the row splitter also skips to the next `]`, wherever that is.
        result +=
          ctx.inTableCell ||
          PIPED_LINK.test(ch + remainder) ||
          (next !== undefined && !isSpace(next) && next !== ']' && remainder.includes(']'))
            ? '\\['
            : ch;
        break;
      case '!': {
        if (ctx.inTableCell && CELL_IMAGE_START.test(ch + remainder)) {
          result += '\\!';
          break;
        }
        const span = IMAGE_SPAN.exec(ch + remainder);
        if (span) {
          const inner = span[1] as string;
          const bar = inner.indexOf('|');
          const body = (bar === -1 ? inner : inner.slice(0, bar)).trim();
          // Jira-safety: `!Nice!` renders as a broken image even without an extension.
          if (IMAGE_BODY.test(body) || /^\S+$/.test(inner)) {
            result += '\\!';
            break;
          }
        }
        result += ch;
        break;
      }
      case '|':
        result += ctx.inTableCell ? '&#124;' : ch;
        break;
      default:
        result += ch;
    }
  }
  return result;
}

/**
 * Pass B: emphasis markers, decided on the structurally escaped line because the parser's closer
 * search skips `\X` pairs, `[…]` and `{{…}}` spans exactly as they will appear in the output. An
 * opener is escaped only when a closer exists; escaping never creates a closer, so left to right is
 * sound.
 */
export function escapeEmphasis(text: string, ctx: EscapeContext): string {
  let result = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k] as string;
    const remainder = text.slice(k + 1) + ctx.rest;
    const next = remainder[0];
    const prev = prevOf(result, ctx.out);
    if (ch === '\\' && next !== undefined) {
      // An escape produced by pass A (or a literal backslash pair) is one unit for the parser too.
      result += ch + next;
      k += 1;
      continue;
    }
    if (ch === '?') {
      result +=
        next === '?' &&
        isOpener(prev, remainder[1], '??') &&
        findCloser(`??${remainder.slice(1)}`, 2, '??') !== -1
          ? '\\?'
          : ch;
      continue;
    }
    if (!EMPHASIS_MARKERS.has(ch)) {
      result += ch;
      continue;
    }
    const opener = isOpener(prev, next, ch) && findCloser(ch + remainder, 1, ch) !== -1;
    const closer =
      ctx.closerMarkers.includes(ch) &&
      prev !== undefined &&
      !isSpace(prev) &&
      (next === undefined || !WORD.test(next));
    result += opener || closer ? `\\${ch}` : ch;
  }
  return result;
}

/**
 * Escapes plain text so the parser reads it back as the same text. Every rule mirrors a parser
 * predicate in `../syntax.ts` or `../parse/*`; the two Jira-safety rules that go beyond the parser
 * (`\[1]`, `Wow\!Nice!`) are marked. A `\` before an escapable character has no escape of its own
 * and becomes the `&#92;` entity, which does not round-trip (warned). For text that shares a line
 * with other segments use the two passes separately, so pass B sees the whole escaped line.
 */
export function escapeWikiText(text: string, ctx: EscapeContext): string {
  return escapeEmphasis(escapeStructural(text, ctx), ctx);
}
