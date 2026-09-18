/**
 * The Jira wiki-markup predicates shared by the parser (read direction) and the serializer (write
 * direction). The serializer escapes exactly where these would fire, so both sides must import the
 * same definitions; nothing in here may depend on either direction.
 */

/** `\X` yields a literal X for these; any other `\X` keeps the backslash. */
export const ESCAPABLE: ReadonlySet<string> = new Set([
  '*',
  '_',
  '-',
  '+',
  '^',
  '~',
  '{',
  '}',
  '[',
  ']',
  '!',
  '|',
  '?',
  '#',
  '\\',
]);
/** What may precede an emphasis opener. */
export const OPENER_BEFORE = /[\s([{"']/;
export const WORD = /[\p{L}\p{N}_]/u;
export const IMAGE_BODY = /^(https?:\/\/\S+|[^!|\n]+\.[A-Za-z0-9]{1,5})$/;
export const IMAGE_PARAM = /^[A-Za-z][\w-]*=[^\s,"|!]+$/;
export const URL_START = /^https?:\/\/[^\s<>\]|]+/;
export const MACRO_OPEN = /^\{([a-zA-Z][\w-]*)(?::([^}\n]*))?\}/;
export const COLOR_OPEN = /^\{color:([^}\n]*)\}/i;
export const COLOR_CLOSE = /\{color\}/i;
/** Colour names and hex values only; anything else keeps the block raw. */
export const COLOR_VALUE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i;
/** Macros the inline scanner understands, so a line starting with one does not open a raw block. */
export const INLINE_MACROS: ReadonlySet<string> = new Set(['color']);

export const HEADING = /^h([1-6])\.\s*(\S.*)$/;
export const RULE = /^-{4,}\s*$/;
export const LIST_ITEM = /^([*#]+|-)\s+(.*)$/;
export const BQ = /^bq\.\s+(.*)$/;
export const VERBATIM_OPEN = /^\{(code|noformat)(?::([^}\n]*))?\}/;
export const TASK = /^\((x|\/)\)\s+/;

export function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Jira opens emphasis only after whitespace or an opening bracket/quote, before a non-space. */
export function isEmphasisOpener(text: string, at: number, marker: string): boolean {
  const prev = text[at - 1];
  const next = text[at + marker.length];
  if (prev !== undefined && !OPENER_BEFORE.test(prev)) return false;
  if (next === undefined || isSpace(next) || next === marker[0]) return false;
  return true;
}

/** Jira closes emphasis only when the marker is preceded by a non-space and followed by a non-word. */
export function findCloser(text: string, from: number, marker: string): number {
  let j = from;
  while (j < text.length) {
    const ch = text[j] as string;
    if (ch === '\n') return -1;
    if (text.startsWith('{{', j)) {
      const end = text.indexOf('}}', j + 2);
      if (end === -1) return -1;
      j = end + 2;
      continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', j + 1);
      if (end === -1) return -1;
      j = end + 1;
      continue;
    }
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (text.startsWith(marker, j) && j > from) {
      const prev = text[j - 1];
      const next = text[j + marker.length];
      if (!isSpace(prev) && (next === undefined || !WORD.test(next))) return j;
    }
    j += 1;
  }
  return -1;
}

/** Trailing punctuation is not part of a bare URL. */
export function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?'"]+$/, '');
  if (out.endsWith(')') && !out.includes('(')) out = out.slice(0, -1);
  return out;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}
