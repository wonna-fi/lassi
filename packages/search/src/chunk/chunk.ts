import { LassiError, parseMarkdown, plainText, splitFrontmatter } from '@wonna/lassi-core';
import type { RootContent } from 'mdast';

export type DocProduct = 'jira' | 'confluence' | 'unknown';

export interface DocMeta {
  product: DocProduct;
  /** Issue key or page id. */
  ref: string;
  title: string;
  url?: string;
}

export interface Chunk {
  ordinal: number;
  /** Heading path such as `Steps > Reproduce`; empty for the metadata chunk and text before the first heading. */
  heading: string;
  /** The markdown of the chunk as written in the file. */
  text: string;
  /** What is embedded: title and heading path in front of the text, so short chunks keep their context. */
  embedText: string;
  /** Offsets into the body (after the frontmatter). */
  start: number;
  end: number;
}

export interface ChunkedDocument {
  meta: DocMeta;
  chunks: Chunk[];
}

export interface ChunkOptions {
  maxChars: number;
  overlap: number;
  /** Used as `ref` when the frontmatter has neither `key` nor `id`. */
  fallbackRef?: string;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Working-file frontmatter  → who this document is. */
export function docMetaFromFrontmatter(
  data: Record<string, unknown> | undefined,
  fallbackRef = ''
): DocMeta {
  const fm = data ?? {};
  const lassi = (fm['lassi'] as Record<string, unknown> | undefined) ?? {};
  const readonly = (fm['readonly'] as Record<string, unknown> | undefined) ?? {};
  const product: DocProduct =
    lassi['product'] === 'jira' || lassi['product'] === 'confluence'
      ? lassi['product']
      : str(fm['key'])
        ? 'jira'
        : str(fm['id']) && str(fm['title'])
          ? 'confluence'
          : 'unknown';
  const ref = str(fm['key']) ?? str(fm['id']) ?? fallbackRef;
  const title = str(fm['summary']) ?? str(fm['title']) ?? ref;
  const url = str(readonly['url']);
  return { product, ref, title, ...(url === undefined ? {} : { url }) };
}

const META_KEYS = ['type', 'status', 'priority', 'assignee', 'labels', 'space', 'parent'];

/** One line of the scalar facts an agent searches by ("open bugs about payments"). */
function metadataLine(meta: DocMeta, data: Record<string, unknown> | undefined): string {
  const fm = data ?? {};
  const readonly = (fm['readonly'] as Record<string, unknown> | undefined) ?? {};
  const facts: string[] = [];
  for (const key of META_KEYS) {
    const value = fm[key] ?? readonly[key];
    if (value === undefined || value === null || value === '') continue;
    facts.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value as string)}`);
  }
  return [`${meta.product} ${meta.ref}: ${meta.title}`, ...facts].join(' | ');
}

interface Section {
  heading: string;
  start: number;
  end: number;
}

function offsetOf(node: RootContent, side: 'start' | 'end'): number | undefined {
  return node.position?.[side].offset;
}

/** Sections split at headings (depth ≤ 3) with the heading path carried along. */
function sections(body: string): Section[] {
  const tree = parseMarkdown(body);
  const out: Section[] = [];
  const path: string[] = [];
  let current: Section | undefined;
  const close = (end: number): void => {
    if (current && end > current.start && body.slice(current.start, end).trim().length > 0) {
      out.push({ ...current, end });
    }
    current = undefined;
  };
  for (const node of tree.children) {
    const start = offsetOf(node, 'start');
    const end = offsetOf(node, 'end');
    if (start === undefined || end === undefined) continue;
    if (node.type === 'heading' && node.depth <= 3) {
      close(start);
      path.splice(node.depth - 1);
      path[node.depth - 1] = plainText(node);
      current = { heading: path.filter(Boolean).join(' > '), start, end };
      continue;
    }
    if (!current) current = { heading: path.filter(Boolean).join(' > '), start, end };
    current.end = end;
  }
  close(body.length);
  return out;
}

interface Piece {
  text: string;
  /** Where `text` starts in the input, so a chunk's offsets address the text it holds. */
  start: number;
}

/** Splits text longer than `max` at blank lines, then hard, carrying `overlap` characters forward. */
function splitLong(text: string, max: number, overlap: number): Piece[] {
  if (text.length <= max) return [{ text, start: 0 }];
  const pieces: Piece[] = [];
  let at = 0;
  while (text.length - at > max) {
    const window = text.slice(at, at + max);
    const blank = window.lastIndexOf('\n\n');
    const cut = blank > max / 2 ? blank : max;
    pieces.push({ text: text.slice(at, at + cut), start: at });
    // The carried tail must be shorter than the piece it follows, or the cursor would not move and
    // the loop would never end: an overlap at or past the cut point is a configuration mistake,
    // not a reason to spin.
    at += cut - Math.min(overlap, Math.floor(cut / 2));
  }
  const tail = text.slice(at);
  if (tail.trim().length > 0) pieces.push({ text: tail, start: at });
  return pieces;
}

/**
 * A working file → embedding units. Chunk 0 is the metadata line, so an issue without a body is
 * still findable; then one chunk per heading section, oversized sections split at blank lines
 * with `overlap` characters carried into the next piece. Fenced code stays inside its section.
 */
export function chunkDocument(markdown: string, opts: ChunkOptions): ChunkedDocument {
  // The config pins this at 200 or more; the export takes whatever a library caller passes, and a
  // non-positive cut leaves the split cursor where it was and allocates until the process dies.
  if (!Number.isInteger(opts.maxChars) || opts.maxChars <= 0) {
    throw new LassiError('validation', `maxChars must be a positive integer, got ${opts.maxChars}`);
  }
  const { data, body } = splitFrontmatter(markdown);
  const meta = docMetaFromFrontmatter(data, opts.fallbackRef);
  const chunks: Chunk[] = [];
  const push = (heading: string, text: string, at: number): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // The offsets address the trimmed text, so `body.slice(start, end)` is the chunk.
    const start = at + (text.length - text.trimStart().length);
    const where = heading ? `${meta.title} — ${heading}` : meta.title;
    chunks.push({
      ordinal: chunks.length,
      heading,
      text: trimmed,
      embedText: `${where}\n${trimmed}`,
      start,
      end: start + trimmed.length,
    });
  };
  const line = metadataLine(meta, data);
  chunks.push({ ordinal: 0, heading: '', text: line, embedText: line, start: 0, end: 0 });
  for (const section of sections(body)) {
    const text = body.slice(section.start, section.end);
    for (const piece of splitLong(text, opts.maxChars, opts.overlap)) {
      push(section.heading, piece.text, section.start + piece.start);
    }
  }
  return { meta, chunks };
}
