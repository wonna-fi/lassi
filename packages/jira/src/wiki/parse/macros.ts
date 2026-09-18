/** `{name}` or `{name:params}` at the start of `text` (offset `at`). */
export interface MacroHeader {
  name: string;
  params: string | undefined;
  /** The matched source, e.g. `{code:java}`. */
  raw: string;
}

import { MACRO_OPEN } from '../syntax.js';

export function parseMacroHeader(text: string, at = 0): MacroHeader | undefined {
  const m = MACRO_OPEN.exec(text.slice(at));
  if (!m) return undefined;
  return { name: (m[1] as string).toLowerCase(), params: m[2], raw: m[0] };
}

export interface CodeParams {
  lang?: string;
  /** A parameter the markdown side cannot carry (title, borderStyle, collapse, …). */
  unsupported: boolean;
}

/**
 * `{code:java}`, `{code:lang=java}`, `{code:language=java}` map to a fence language; anything
 * else (`{code:title=Foo.java|borderStyle=solid}`) keeps the block as a raw fence so nothing is lost.
 */
export function parseCodeParams(params: string | undefined): CodeParams {
  if (params === undefined || params.trim() === '') return { unsupported: false };
  const out: CodeParams = { unsupported: false };
  for (const part of params.split('|')) {
    const piece = part.trim();
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq === -1) {
      if (out.lang !== undefined) return { unsupported: true };
      out.lang = piece;
      continue;
    }
    const key = piece.slice(0, eq).trim().toLowerCase();
    const value = piece.slice(eq + 1).trim();
    if (key === 'lang' || key === 'language') {
      if (out.lang !== undefined) return { unsupported: true };
      out.lang = value;
    } else {
      return { unsupported: true };
    }
  }
  return out;
}
