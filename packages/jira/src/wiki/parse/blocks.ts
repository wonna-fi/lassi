import { BQ, HEADING, INLINE_MACROS, LIST_ITEM, RULE, VERBATIM_OPEN } from '../syntax.js';
import { parseCodeParams, parseMacroHeader } from './macros.js';
import { parseTable, type WikiRow } from './tables.js';

export interface ListItemToken {
  markers: string;
  text: string;
}

export type BlockToken =
  | { type: 'heading'; depth: number; text: string; source: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'bq'; lines: string[] }
  | { type: 'quote'; body: BlockToken[]; source: string[] }
  | { type: 'code'; lang: string | undefined; value: string; noformat: boolean }
  | { type: 'raw'; lines: string[] }
  | { type: 'rule' }
  | { type: 'table'; rows: WikiRow[]; source: string[] }
  | { type: 'list'; items: ListItemToken[]; source: string[] };

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * Does this line start a construct that terminates the current paragraph / list / bq? Every
 * `{macro}` at the start of a line does, except the inline macros the inline scanner understands.
 */
export function startsBlock(line: string): boolean {
  const t = line.trimStart();
  if (HEADING.test(t) || RULE.test(t) || BQ.test(t)) return true;
  if (t.startsWith('|')) return true;
  if (LIST_ITEM.test(t)) return true;
  if (VERBATIM_OPEN.test(t)) return true;
  if (t.startsWith('{quote}')) return true;
  const macro = parseMacroHeader(t);
  if (macro && !INLINE_MACROS.has(macro.name) && t.startsWith(macro.raw)) return true;
  return false;
}

interface Cursor {
  lines: string[];
  i: number;
}

function readVerbatim(c: Cursor): BlockToken | undefined {
  const first = c.lines[c.i] as string;
  const t = first.trimStart();
  const open = VERBATIM_OPEN.exec(t);
  if (!open) return undefined;
  const name = open[1] as string;
  const closer = `{${name}}`;
  const sourceLines: string[] = [];
  const bodyLines: string[] = [];
  let rest = t.slice(open[0].length);
  let closed = false;
  let trailing = '';
  let j = c.i;
  // Opener and closer may share a line with content.
  for (;;) {
    const closeAt = rest.indexOf(closer);
    if (closeAt !== -1) {
      bodyLines.push(rest.slice(0, closeAt));
      trailing = rest.slice(closeAt + closer.length);
      sourceLines.push(c.lines[j] as string);
      closed = true;
      break;
    }
    bodyLines.push(rest);
    sourceLines.push(c.lines[j] as string);
    j += 1;
    if (j >= c.lines.length) break;
    rest = c.lines[j] as string;
  }
  if (!closed) return undefined;
  c.i = j + 1;
  if (trailing.trim().length > 0) c.lines.splice(c.i, 0, trailing);
  const params = parseCodeParams(open[2]);
  if (params.unsupported) return { type: 'raw', lines: sourceLines };
  // The opener line's remainder and the closer line's prefix are content only when non-empty.
  if (bodyLines.length > 0 && (bodyLines[0] as string).trim() === '') bodyLines.shift();
  if (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] as string).trim() === '')
    bodyLines.pop();
  const value = bodyLines.join('\n');
  if (name === 'noformat') return { type: 'code', lang: 'noformat', value, noformat: true };
  return { type: 'code', lang: params.lang, value, noformat: false };
}

function readQuote(c: Cursor): BlockToken | undefined {
  const first = (c.lines[c.i] as string).trimStart();
  if (!first.startsWith('{quote}')) return undefined;
  const closer = '{quote}';
  const source: string[] = [];
  const body: string[] = [];
  let rest = first.slice(closer.length);
  let j = c.i;
  let closed = false;
  for (;;) {
    const at = rest.indexOf(closer);
    if (at !== -1) {
      const before = rest.slice(0, at);
      if (before.trim().length > 0) body.push(before);
      source.push(c.lines[j] as string);
      const trailing = rest.slice(at + closer.length);
      c.i = j + 1;
      if (trailing.trim().length > 0) c.lines.splice(c.i, 0, trailing);
      closed = true;
      break;
    }
    if (j !== c.i || rest.trim().length > 0) body.push(rest);
    source.push(c.lines[j] as string);
    j += 1;
    if (j >= c.lines.length) break;
    rest = c.lines[j] as string;
  }
  if (!closed) return undefined;
  return { type: 'quote', body: tokenizeBlocks(body), source };
}

/** Is the macro closer somewhere in the paragraph run that starts at the cursor? */
function closerInParagraphRun(c: Cursor, closer: string): boolean {
  for (let j = c.i; j < c.lines.length; j++) {
    const line = c.lines[j] as string;
    if (isBlank(line) || (j > c.i && startsBlock(line))) return false;
    if (line.toLowerCase().includes(closer)) return true;
  }
  return false;
}

function readRawMacro(c: Cursor, force = false): BlockToken | undefined {
  const first = (c.lines[c.i] as string).trimStart();
  const macro = parseMacroHeader(first);
  if (!macro || (!force && INLINE_MACROS.has(macro.name))) return undefined;
  const closer = `{${macro.name}}`;
  // A closer on the same line ({color:red}x{color}) or a self-contained macro ({toc}, {anchor:x})
  // is a one-line raw block; otherwise the block runs to the first later line holding the closer.
  const rest = first.slice(macro.raw.length);
  if (!rest.includes(closer)) {
    for (let j = c.i + 1; j < c.lines.length; j++) {
      if ((c.lines[j] as string).includes(closer)) {
        const lines = c.lines.slice(c.i, j + 1);
        c.i = j + 1;
        return { type: 'raw', lines };
      }
    }
  }
  c.i += 1;
  return { type: 'raw', lines: [c.lines[c.i - 1] as string] };
}

function readTable(c: Cursor): BlockToken {
  const source: string[] = [];
  // A row that does not end with a pipe continues on the next lines (a multi-line cell); those
  // lines belong to the table too, so the whole thing is kept together when it is fenced.
  let open = false;
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isBlank(line)) break;
    if (!open && !line.trimStart().startsWith('|')) break;
    source.push(line);
    c.i += 1;
    open = !line.trimEnd().endsWith('|');
  }
  const rows = parseTable(source);
  if (!rows) return { type: 'raw', lines: source };
  return { type: 'table', rows, source };
}

function readList(c: Cursor): BlockToken {
  const items: ListItemToken[] = [];
  const source: string[] = [];
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isBlank(line)) break;
    const m = LIST_ITEM.exec(line.trimStart());
    if (m) {
      const markers = m[1] === '-' ? '*' : (m[1] as string);
      items.push({ markers, text: m[2] as string });
      source.push(line);
      c.i += 1;
      continue;
    }
    if (startsBlock(line) || items.length === 0) break;
    const last = items[items.length - 1] as ListItemToken;
    last.text += `\n${line.trim()}`;
    source.push(line);
    c.i += 1;
  }
  return { type: 'list', items, source };
}

function readParagraphLike(c: Cursor): string[] {
  const lines: string[] = [];
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isBlank(line)) break;
    if (lines.length > 0 && startsBlock(line)) break;
    // Jira ignores indentation inside paragraphs; trailing spaces would leak into hard breaks.
    lines.push(line.trim());
    c.i += 1;
  }
  return lines;
}

/** Line-based block tokenizer for Jira wiki markup; unknown constructs become raw blocks. */
export function tokenizeBlocks(input: string[]): BlockToken[] {
  const c: Cursor = { lines: [...input], i: 0 };
  const out: BlockToken[] = [];
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isBlank(line)) {
      c.i += 1;
      continue;
    }
    const t = line.trimStart();

    const verbatim = readVerbatim(c);
    if (verbatim) {
      out.push(verbatim);
      continue;
    }
    if (t.startsWith('{quote}')) {
      const quote = readQuote(c);
      if (quote) {
        out.push(quote);
        continue;
      }
    }
    const macro = parseMacroHeader(t);
    if (macro && !VERBATIM_OPEN.test(t) && macro.name !== 'quote') {
      // An inline macro opened at line start stays a paragraph when it closes inside the same
      // paragraph run; one spanning paragraphs is a raw block to its closer.
      const inline = INLINE_MACROS.has(macro.name);
      if (!inline || !closerInParagraphRun(c, `{${macro.name}}`)) {
        const raw = readRawMacro(c, inline);
        if (raw) {
          out.push(raw);
          continue;
        }
      }
    }

    const heading = HEADING.exec(t);
    if (heading) {
      out.push({
        type: 'heading',
        depth: Number(heading[1]),
        text: (heading[2] as string).trim(),
        source: line,
      });
      c.i += 1;
      continue;
    }
    if (RULE.test(t)) {
      out.push({ type: 'rule' });
      c.i += 1;
      continue;
    }
    if (t.startsWith('|')) {
      out.push(readTable(c));
      continue;
    }
    if (LIST_ITEM.test(t)) {
      out.push(readList(c));
      continue;
    }
    const bq = BQ.exec(t);
    if (bq) {
      c.i += 1;
      const rest = readParagraphLike(c);
      out.push({ type: 'bq', lines: [bq[1] as string, ...rest] });
      continue;
    }
    const lines = readParagraphLike(c);
    if (lines.length === 0) {
      c.i += 1;
      continue;
    }
    out.push({ type: 'paragraph', lines });
  }
  return out;
}
