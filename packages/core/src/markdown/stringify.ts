import type { Link, Parents, Root, Text } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import {
  defaultHandlers,
  toMarkdown,
  type ConstructName,
  type Info,
  type Options,
  type State,
  type Unsafe,
} from 'mdast-util-to-markdown';
import { mentionToMarkdown, escapeMentionStarts } from './mention.js';
import { parseMarkdown, type ParseMarkdownOptions } from './parse.js';

/** Pinned so every converter and fixture agrees on one canonical markdown form. */
export const STRINGIFY_OPTIONS: Readonly<Options> = {
  bullet: '-',
  bulletOther: '*',
  bulletOrdered: '.',
  emphasis: '*',
  strong: '*',
  fences: true,
  fence: '`',
  listItemIndent: 'one',
  rule: '-',
  ruleRepetition: 3,
  ruleSpaces: false,
  resourceLink: false,
  setext: false,
  tightDefinitions: true,
  incrementListMarker: true,
};

// Same list mdast-util-to-markdown uses for its own `_` rule (not exported by the package).
const FULL_PHRASING_SPANS: ConstructName[] = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
];

/** A GFM autolink literal: one text child that is the URL itself (or its mailto:/http: form). */
function autolinkLiteralText(node: Link): string | undefined {
  if (node.title || node.children.length !== 1) return undefined;
  const child = node.children[0];
  if (!child || child.type !== 'text') return undefined;
  const { value } = child;
  if (node.url === value || node.url === `mailto:${value}` || node.url === `http://${value}`) {
    return value;
  }
  return undefined;
}

/**
 * Bare URLs and e-mail addresses stay bare. The default handler would wrap them in `<…>`, which
 * agents never write and which would show up as spurious diffs in working files.
 */
/**
 * Anything the stringifier may escape right after a bare literal is swallowed by it on re-parse:
 * `https://x.example.internal/a*` is written with a `\*` and reads back as a URL ending in `\`,
 * so the link target drifts on every round trip. The bare form is therefore used only when what
 * follows cannot grow a backslash: nothing, whitespace, or plain sentence punctuation.
 */
const SAFE_AFTER_LITERAL = /^[\s.,;:?)'"]/;

function bareLiteral(node: Link, parent: Parents | undefined): string | undefined {
  const literal = autolinkLiteralText(node);
  if (literal === undefined) return undefined;
  // Only an `http(s)` literal can grow: an e-mail or `www.` literal stops at the backslash.
  if (parent && /^https?:\/\//.test(node.url)) {
    const next = parent.children[parent.children.findIndex((child) => child === node) + 1];
    if (next !== undefined) {
      if (next.type !== 'text') return undefined;
      if (!SAFE_AFTER_LITERAL.test(next.value)) return undefined;
    }
  }
  return literal;
}

function bareAutolinkLink(
  node: Link,
  parent: Parents | undefined,
  state: State,
  info: Info
): string {
  const literal = bareLiteral(node, parent);
  if (literal !== undefined) return literal;
  return defaultHandlers.link(node, parent, state, info);
}
bareAutolinkLink.peek = function peek(
  node: Link,
  parent: Parents | undefined,
  state: State
): string {
  const literal = bareLiteral(node, parent);
  if (literal !== undefined) return literal.charAt(0);
  return defaultHandlers.link.peek(node, parent, state);
};

function isUnconditionalUnderscore(rule: Unsafe): boolean {
  return rule.character === '_' && rule.inConstruct === 'phrasing' && !rule.before && !rule.after;
}

/**
 * mdast-util-to-markdown escapes every `_` in phrasing, which turns `snake_case` into
 * `snake\_case` and breaks the md → wiki → md fixed point. CommonMark only lets `_` open or close
 * emphasis next to a non-alphanumeric, so this handler drops the unconditional rule while the
 * narrower rules below (added through `unsafe`) keep escaping the positions that matter.
 * `*` keeps its default rule: CommonMark allows intra-word `*` emphasis.
 */
function intrawordSafeText(node: Text, _parent: unknown, state: State, info: Info): string {
  const original = state.unsafe;
  state.unsafe = original.filter((rule) => !isUnconditionalUnderscore(rule));
  try {
    return escapeMentionStarts(state.safe(node.value, info), info.before);
  } finally {
    state.unsafe = original;
  }
}

function intrawordSafe(): Options {
  return {
    handlers: {
      text: intrawordSafeText,
      link: bareAutolinkLink,
    },
    unsafe: [
      {
        character: '_',
        inConstruct: 'phrasing',
        notInConstruct: FULL_PHRASING_SPANS,
        before: '(?:^|[^A-Za-z0-9])',
      },
      {
        character: '_',
        inConstruct: 'phrasing',
        notInConstruct: FULL_PHRASING_SPANS,
        after: '(?:[^A-Za-z0-9]|$)',
      },
    ],
  };
}

export interface StringifyMarkdownOptions {
  /** Additional mdast-util-to-markdown extensions (handlers + unsafe) for product node types. */
  extensions?: Options[];
}

const ATTENTION: ReadonlySet<string> = new Set(['strong', 'emphasis', 'delete']);

/**
 * Merges runs of adjacent same-type emphasis into one span, on a copy of the tree.
 *
 * Markdown cannot keep them apart. One marker written twice over (`**a****z**`) is a single
 * delimiter run and reparses as one span, and the other marker for the same construct only works
 * away from word characters: `_` may not open after one or close before one, so `x**a**__b__c` has
 * no spelling at all — and neither does any run of even length between two word characters.
 *
 * The distinction is not worth preserving anyway. Two adjacent strong spans render exactly as one
 * containing both, so merging is a normalisation  rather than a loss, and it is a fixed
 * point: the merged form reads back as itself.
 */
function mergeAttentionRuns<T>(node: T): T {
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return node;
  const out: Array<{ type?: string; children?: unknown[] }> = [];
  for (const child of children) {
    const merged = mergeAttentionRuns(child) as { type?: string; children?: unknown[] };
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      merged.type !== undefined &&
      last.type === merged.type &&
      ATTENTION.has(merged.type) &&
      Array.isArray(last.children) &&
      Array.isArray(merged.children)
    ) {
      last.children = [...last.children, ...merged.children];
      continue;
    }
    out.push(merged);
  }
  return { ...node, children: out };
}

export function stringifyMarkdown(tree: Root, opts: StringifyMarkdownOptions = {}): string {
  return toMarkdown(mergeAttentionRuns(tree), {
    ...STRINGIFY_OPTIONS,
    extensions: [
      gfmToMarkdown({ tablePipeAlign: false, tableCellPadding: true }),
      mentionToMarkdown(),
      intrawordSafe(),
      ...(opts.extensions ?? []),
    ],
  });
}

/** Canonical form: `stringify(parse(md))`. Fixed-point tests compare against this. */
export function normalizeMarkdown(
  markdown: string,
  opts: { parse?: ParseMarkdownOptions; stringify?: StringifyMarkdownOptions } = {}
): string {
  return stringifyMarkdown(parseMarkdown(markdown, opts.parse), opts.stringify);
}
