/**
 * Two properties fixtures cannot give: (1) the escaper round-trips arbitrary text through the parser,
 * (2) a generated canonical GFM subset is a fixed point of md → wiki → md.
 *
 * Deliberately outside the generators, because they are documented non-fixed-points: a backslash
 * before a special character (`&#92;`), `&#124;` in prose, `(x)`/`(/)` at the start of a plain list
 * item, loose lists and list start numbers, table alignment, link titles and formatted labels,
 * `<br>`, soft line breaks, image alt texts, and `www.`/`://` inside plain words.
 */
import { normalizeMarkdown, stringifyMarkdown } from '@wonna/lassi-core';
import fc from 'fast-check';
import type { List, ListItem, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { describe, expect, it } from 'vitest';
import { wikiToMarkdown, wikiToMdast } from '../index.js';
import { parseInline } from '../parse/inline.js';
import { splitRow } from '../parse/tables.js';
import { escapeWikiText } from './escape.js';
import { markdownToWiki } from './index.js';
import { Warnings } from './warnings.js';

// 200 deterministic round-trips through the parser, not a unit test: vitest's 5-second
// default is a budget for something else, and a slow shared runner has tripped it.
const PROPERTY_TIMEOUT_MS = 30_000;

const RUNS = { numRuns: 200, seed: 20260905, endOnFailure: true };

const word = fc
  .stringMatching(/^[A-Za-z0-9.,;:()"'!?*_{}[\]|#~^+/=-]{1,8}$/)
  .filter(
    (w) => !/^h[1-6]\./.test(w) && w !== 'bq.' && !w.includes('://') && !w.startsWith('www.')
  );
const words = fc.array(word, { minLength: 1, maxLength: 8 }).map((ws) => ws.join(' '));

describe('property: the escaper mirrors the parser', () => {
  it(
    'escaped text parses back as the same plain paragraph',
    () => {
      fc.assert(
        fc.property(words, (text) => {
          const escaped = escapeWikiText(text, {
            out: '',
            rest: '',
            lineStart: true,
            paragraphStart: true,
            inTableCell: false,
            closerMarkers: [],
            warnings: new Warnings(),
          });
          const tree = wikiToMdast(escaped);
          expect(tree.children).toHaveLength(1);
          const block = tree.children[0] as Paragraph;
          expect(block.type).toBe('paragraph');
          expect(block.children.every((n) => n.type === 'text')).toBe(true);
          expect(toString(block)).toBe(text);
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'escaped cell text splits and parses back as the same text',
    () => {
      fc.assert(
        fc.property(words, (text) => {
          const escaped = escapeWikiText(text, {
            out: '',
            rest: '',
            lineStart: false,
            paragraphStart: false,
            inTableCell: true,
            closerMarkers: [],
            warnings: new Warnings(),
          });
          const row = splitRow(`|${escaped}|`);
          expect(row?.cells).toHaveLength(1);
          const parsed = parseInline(row?.cells[0] ?? '', { inTableCell: true });
          expect(parsed.unsupported).toEqual([]);
          expect(parsed.nodes.every((n) => n.type === 'text')).toBe(true);
          expect(parsed.nodes.map((n) => (n.type === 'text' ? n.value : '')).join('')).toBe(text);
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

// --- Property 2: a canonical GFM subset -------------------------------------------------------

const plainWord = fc.stringMatching(/^[A-Za-z0-9]{1,6}$/);
const trickyWord = fc.constantFrom(
  'C++',
  '-1',
  'snake_case',
  '2*3',
  '{x}',
  '[1]',
  'a!b',
  'x|y',
  '??',
  '{code}',
  '----',
  'foo*bar',
  '(!)',
  'e^2^',
  'a_b_c'
);
const textValue = fc
  .array(fc.oneof({ weight: 4, arbitrary: plainWord }, { weight: 1, arbitrary: trickyWord }), {
    minLength: 1,
    maxLength: 4,
  })
  .map((ws) => ws.join(' '));
const text = textValue.map((value): PhrasingContent => ({ type: 'text', value }));
const url = fc.constantFrom(
  'https://x.example.com/a_b',
  'https://x.example.com/p?q=1',
  'https://y.example.com'
);
const inlineLeaf: fc.Arbitrary<PhrasingContent> = fc.oneof(
  { weight: 4, arbitrary: text },
  {
    weight: 1,
    arbitrary: fc
      .stringMatching(/^[A-Za-z0-9 |*_{[\]!-]{1,10}$/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && !v.includes('}}') && !v.endsWith('}'))
      .map((value): PhrasingContent => ({ type: 'inlineCode', value })),
  },
  {
    weight: 1,
    arbitrary: fc.tuple(plainWord, url).map(([label, href]): PhrasingContent => ({
      type: 'link',
      url: href,
      children: [{ type: 'text', value: label }],
    })),
  },
  {
    weight: 1,
    arbitrary: url.map((href): PhrasingContent => ({
      type: 'link',
      url: href,
      children: [{ type: 'text', value: href }],
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('jsmith', 'j.smith-jr_2', 'jdoe')
      .map((username): PhrasingContent => ({ type: 'mention', username }) as PhrasingContent),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom('screen.png', 'img-1.jpg'),
        fc.constantFrom(undefined, 'thumbnail', 'width=100 height=50', 'align=right')
      )
      .map(([file, title]): PhrasingContent => ({
        type: 'image',
        url: `attachment:${file}`,
        alt: file,
        ...(title === undefined ? {} : { title }),
      })),
  }
);
const emphasisNode: fc.Arbitrary<PhrasingContent> = fc
  .tuple(fc.constantFrom('strong', 'emphasis', 'delete'), textValue)
  .map(([type, value]) => ({ type, children: [{ type: 'text', value }] }) as PhrasingContent);

/** Inline nodes separated by single spaces so no two texts or markers touch by accident. */
function phrasing(allowBreak: boolean): fc.Arbitrary<PhrasingContent[]> {
  return fc
    .array(fc.oneof({ weight: 3, arbitrary: inlineLeaf }, { weight: 1, arbitrary: emphasisNode }), {
      minLength: 1,
      maxLength: 5,
    })
    .chain((nodes) =>
      fc
        .array(fc.boolean(), {
          minLength: Math.max(0, nodes.length - 1),
          maxLength: Math.max(0, nodes.length - 1),
        })
        .map((breaks) => {
          const out: PhrasingContent[] = [];
          nodes.forEach((node, i) => {
            if (i > 0) {
              const hard = allowBreak && breaks[i - 1] === true;
              out.push(hard ? { type: 'break' } : { type: 'text', value: ' ' });
            }
            out.push(node);
          });
          return mergeText(out);
        })
    );
}

function mergeText(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else out.push(node);
  }
  return out;
}

const listItem = (depth: number): fc.Arbitrary<ListItem> =>
  fc
    .tuple(
      phrasing(false).filter(
        (p) => !/^\((x|\/)\) /.test(toString({ type: 'paragraph', children: p }))
      ),
      fc.constantFrom(undefined, true, false),
      depth < 2 ? fc.option(list(depth + 1), { nil: undefined }) : fc.constant(undefined)
    )
    .map(([children, checked, nested]) => {
      const item: ListItem = {
        type: 'listItem',
        spread: false,
        children: [{ type: 'paragraph', children }],
      };
      if (checked !== undefined) item.checked = checked;
      if (nested) item.children.push(nested);
      return item;
    });

function list(depth: number): fc.Arbitrary<List> {
  return fc
    .tuple(fc.boolean(), fc.array(listItem(depth), { minLength: 1, maxLength: 3 }))
    .map(([ordered, children]) => ({ type: 'list', ordered, spread: false, children }));
}

const codeLine = fc
  .oneof(textValue, fc.constantFrom('{code:java}', '*x*', '{{y}}', '  indented', ''))
  .filter((line) => line !== '{code}' && line !== '{noformat}');
const block: fc.Arbitrary<RootContent> = fc.oneof(
  {
    weight: 4,
    arbitrary: phrasing(true).map((children): RootContent => ({ type: 'paragraph', children })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 6 }), phrasing(false))
      .map(([depth, children]): RootContent => ({ type: 'heading', depth: depth as 1, children })),
  },
  { weight: 2, arbitrary: list(1) },
  {
    weight: 1,
    arbitrary: phrasing(false).map((children): RootContent => ({
      type: 'blockquote',
      children: [{ type: 'paragraph', children }],
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom(null, 'ts', 'java', 'noformat'),
        fc.array(codeLine, { minLength: 1, maxLength: 3 })
      )
      .map(([lang, lines]): RootContent => ({ type: 'code', lang, value: lines.join('\n') })),
  },
  { weight: 1, arbitrary: fc.constant({ type: 'thematicBreak' } as RootContent) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 2, max: 3 }), fc.integer({ min: 1, max: 3 }))
      .chain(([cols, rows]) =>
        fc
          .array(
            fc.array(
              fc
                .array(inlineLeaf, { minLength: 0, maxLength: 2 })
                .map((nodes) =>
                  mergeText(
                    nodes.flatMap((n, i) =>
                      i > 0 ? [{ type: 'text', value: ' ' } as PhrasingContent, n] : [n]
                    )
                  )
                ),
              { minLength: cols, maxLength: cols }
            ),
            { minLength: rows + 1, maxLength: rows + 1 }
          )
          .map((table): RootContent => ({
            type: 'table',
            align: Array.from({ length: cols }, () => null),
            children: table.map((cells) => ({
              type: 'tableRow',
              children: cells.map((children) => ({ type: 'tableCell', children })),
            })),
          }))
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      // A fence holding a GFM-representable table would rightly read back as a table, so the row
      // below is wider than its header and stays raw.
      .constantFrom('{panel}x{panel}', '||h||\n|too|wide|', '{anchor:a}')
      .map((value): RootContent => ({ type: 'code', lang: 'jira', value })),
  }
);
const document: fc.Arbitrary<Root> = fc
  .array(block, { minLength: 1, maxLength: 4 })
  .map((children) => ({ type: 'root', children }));

describe('property: a canonical GFM subset round-trips through wiki markup', () => {
  it(
    'md → wiki → md is the identity on canonical markdown',
    () => {
      fc.assert(
        fc.property(document, (tree) => {
          const md = stringifyMarkdown(tree);
          fc.pre(normalizeMarkdown(md) === md);
          const { wiki } = markdownToWiki(md);
          expect(wiki.endsWith('\n')).toBe(true);
          expect(wikiToMarkdown(wiki)).toBe(md);
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
