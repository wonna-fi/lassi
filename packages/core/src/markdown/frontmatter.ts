import { Document, isMap, isNode, parse } from 'yaml';
import { LassiError } from '../errors/lassi-error.js';

export interface SplitResult {
  data?: Record<string, unknown>;
  body: string;
}

const OPEN = /^---[ \t]*\r?\n/;

/**
 * Splits a leading `---` block. YAML 1.2 core schema on purpose: timestamps stay strings, which is
 * what the frontmatter diff compares.
 */
export function splitFrontmatter(text: string): SplitResult {
  const open = OPEN.exec(text);
  if (!open) return { body: text };
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) throw new LassiError('usage', 'frontmatter block is not closed with ---');
  const yamlText = rest.slice(0, close.index);
  let data: unknown;
  try {
    data = parse(yamlText, { schema: 'core' });
  } catch (err) {
    throw new LassiError('usage', `invalid YAML frontmatter: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) {
    throw new LassiError('usage', 'frontmatter must be a YAML mapping');
  }
  let body = rest.slice(close.index + close[0].length);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return { data: (data ?? {}) as Record<string, unknown>, body };
}

export interface JoinOptions {
  /** Top-level maps rendered inline (`counts: { comments: 7, ... }`), */
  flowKeys?: string[];
  /** Top-level key → trailing comment (`customfield_10005: 3 # Story Points`). */
  comments?: Record<string, string>;
}

export function joinFrontmatter(
  data: Record<string, unknown>,
  body: string,
  opts: JoinOptions = {}
): string {
  const doc = new Document(data, { schema: 'core' });
  for (const key of opts.flowKeys ?? []) {
    const node = doc.get(key, true);
    if (isMap(node)) node.flow = true;
  }
  for (const [key, text] of Object.entries(opts.comments ?? {})) {
    const node = doc.get(key, true);
    if (isNode(node)) node.comment = ` ${text}`;
  }
  const yamlText = doc.toString({ lineWidth: 0 });
  const trimmedBody = body.replace(/\s+$/, '');
  return `---\n${yamlText}---\n${trimmedBody.length > 0 ? `\n${trimmedBody}\n` : ''}`;
}
