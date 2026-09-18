/**
 * Two properties the fixtures cannot give: (1) escaped text survives the reader unchanged, (2) a
 * generated canonical markdown subset is a fixed point of md -> storage -> md, and its storage is a
 * fixed point of storage -> md -> storage.
 *
 * Outside the generators by design (to keep the generated inputs representable): runs of whitespace and edge whitespace
 * inside inline formatting (the reader collapses them), hard breaks in headings and table cells,
 * a code fence with meta but no language (the info string's first word is the language), link
 * labels with formatting (flattened), `[!CAUTION]`, and tables whose header cells are all empty
 * next to a real header (the empty header row means "no header").
 */
import fc from 'fast-check';
import type {
  BlockContent,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { toString } from 'mdast-util-to-string';
import { describe, expect, it } from 'vitest';
import { storageToMarkdown } from './index.js';
import type { Alert } from './md/alert.js';
import { normalizeConfluenceMarkdown, stringifyConfluenceMarkdown } from './md/index.js';
import { markdownToStorage } from './mdast-to-storage.js';
import { normalizeStorage } from './normalize.js';
import { storageToMdast } from './storage-to-mdast.js';
import { userDirectory } from './users.js';
import { escapeText } from './xml/escape.js';

// 200 deterministic round-trips through the parser, not a unit test: vitest's 5-second
// default is a budget for something else, and a slow shared runner has tripped it.
const PROPERTY_TIMEOUT_MS = 30_000;

const RUNS = { numRuns: 200, seed: 20260905, endOnFailure: true };
const users = userDirectory([
  { userKey: 'k1', username: 'jsmith' },
  { userKey: 'k2', username: 'jdoe' },
]);

describe('property: escaped text survives the reader', () => {
  const chunk = fc.stringMatching(/^[A-Za-z0-9&<>"'.,;:!?()\- ’— ]{1,12}$/);
  const text = fc
    .array(chunk, { minLength: 1, maxLength: 6 })
    .map((cs) => cs.join(' '))
    .filter((t) => t.trim() === t && !/[  ]{2}/.test(t));

  it(
    'reads back as the same paragraph text',
    () => {
      fc.assert(
        fc.property(text, (value) => {
          const tree = storageToMdast(`<p>${escapeText(value)}</p>`).tree;
          expect(tree.children).toHaveLength(1);
          const p = tree.children[0] as Paragraph;
          expect(p.type).toBe('paragraph');
          expect(toString(p)).toBe(value);
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

// --- Property 2: a canonical markdown subset ------------------------------------------------------

const plainWord = fc.stringMatching(/^[A-Za-z0-9]{1,6}$/);
const trickyWord = fc.constantFrom(
  'a&b',
  '<tag>',
  'x_y',
  '*star*',
  '@handle',
  '[[x]]',
  '{jira:X}',
  '#hash',
  '1.',
  '-',
  'a|b',
  'back\\slash',
  '&nbsp;',
  ']]>',
  'C++',
  '"quoted"',
  "it's",
  'e=mc2'
);
const textValue = fc
  .array(fc.oneof({ weight: 4, arbitrary: plainWord }, { weight: 1, arbitrary: trickyWord }), {
    minLength: 1,
    maxLength: 4,
  })
  .map((ws) => ws.join(' '));
const text = textValue.map((value): PhrasingContent => ({ type: 'text', value }));
const url = fc.constantFrom(
  'https://x.example.internal/a_b',
  'https://x.example.internal/p?q=1&r=2',
  'https://y.example.internal'
);
const inlineLeaf: fc.Arbitrary<PhrasingContent> = fc.oneof(
  { weight: 5, arbitrary: text },
  {
    weight: 1,
    arbitrary: textValue.map((value): PhrasingContent => ({ type: 'inlineCode', value })),
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
      .constantFrom('jsmith', 'jdoe')
      .map(
        (username): PhrasingContent => ({ type: 'mention', username }) as unknown as PhrasingContent
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.option(fc.constantFrom('DEV', 'PROJ'), { nil: undefined }),
        plainWord,
        fc.option(plainWord, { nil: undefined })
      )
      .map(
        ([space, title, body]): PhrasingContent =>
          ({
            type: 'pageLink',
            ...(space === undefined ? {} : { space }),
            title,
            ...(body === undefined ? {} : { body }),
          }) as unknown as PhrasingContent
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .stringMatching(/^[A-Z]{2,4}-[1-9][0-9]{0,3}$/)
      .map(
        (key): PhrasingContent =>
          ({ type: 'jiraMacro', key, params: [] }) as unknown as PhrasingContent
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(plainWord, fc.constantFrom('shot.png', 'diagram.svg'))
      .map(([alt, file]): PhrasingContent => ({
        type: 'image',
        url: `attachment:${file}`,
        alt,
        title: 'height=20 width=10',
      })),
  }
);
const emphasis: fc.Arbitrary<PhrasingContent> = fc
  .tuple(fc.constantFrom('strong', 'emphasis', 'delete'), text)
  .map(([type, child]) => ({ type, children: [child] }) as PhrasingContent);

/** Leaves separated by plain text so adjacent constructs never merge or touch. */
function interleave(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  nodes.forEach((node, i) => {
    if (i > 0) out.push({ type: 'text', value: ' and ' });
    out.push(node);
  });
  return out;
}
const inline = fc
  .array(fc.oneof({ weight: 3, arbitrary: inlineLeaf }, { weight: 1, arbitrary: emphasis }), {
    minLength: 1,
    maxLength: 4,
  })
  .map(interleave);
const inlineWithBreak = fc
  .tuple(inline, inline)
  .map(([a, b]): PhrasingContent[] => [...a, { type: 'break' }, ...b]);

const paragraph: fc.Arbitrary<Paragraph> = fc
  .oneof({ weight: 4, arbitrary: inline }, { weight: 1, arbitrary: inlineWithBreak })
  .map((children) => ({ type: 'paragraph', children }));
const heading: fc.Arbitrary<Heading> = fc
  .tuple(fc.constantFrom(1, 2, 3, 4, 5, 6), inline)
  .map(([depth, children]) => ({ type: 'heading', depth: depth as 1, children }));
const code: fc.Arbitrary<Code> = fc
  .tuple(
    fc.option(fc.constantFrom('js', 'java', 'bash'), { nil: null }),
    fc.option(fc.constantFrom('title=Foo.java', 'collapse=true linenumbers=true'), { nil: null }),
    fc.array(textValue, { minLength: 1, maxLength: 3 }).map((ls) => ls.join('\n'))
  )
  .map(([lang, meta, value]) => ({
    type: 'code',
    lang,
    meta: lang === null ? null : meta,
    value,
  }));
const noformat: fc.Arbitrary<Code> = textValue.map((value) => ({
  type: 'code',
  lang: 'noformat',
  meta: null,
  value: `  ${value}  `,
}));
const rawFence: fc.Arbitrary<Code> = fc
  .constantFrom(
    '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>hidden</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>x</p></ac:layout-cell></ac:layout-section></ac:layout>'
  )
  .map((value) => ({ type: 'code', lang: 'confluence', meta: null, value }));

function tightItem(children: PhrasingContent[], nested?: List): ListItem {
  const kids: BlockContent[] = [{ type: 'paragraph', children }];
  if (nested) kids.push(nested);
  return { type: 'listItem', spread: false, children: kids };
}
const leafList: fc.Arbitrary<List> = fc
  .tuple(fc.boolean(), fc.array(inline, { minLength: 1, maxLength: 3 }))
  .map(([ordered, items]) => ({
    type: 'list',
    ordered,
    start: ordered ? 1 : null,
    spread: false,
    children: items.map((i) => tightItem(i)),
  }));
const nestedList: fc.Arbitrary<List> = fc
  .tuple(
    fc.boolean(),
    fc.option(fc.constantFrom(1, 3, 10), { nil: null }),
    inline,
    leafList,
    inline
  )
  .map(([ordered, start, a, nested, b]) => ({
    type: 'list',
    ordered,
    start: ordered ? start : null,
    spread: false,
    children: [tightItem(a, nested), tightItem(b)],
  }));
const looseList: fc.Arbitrary<List> = fc
  .array(fc.array(inline, { minLength: 1, maxLength: 2 }), { minLength: 1, maxLength: 3 })
  .map((items) => ({
    type: 'list',
    ordered: false,
    start: null,
    spread: true,
    children: items.map((paras): ListItem => ({
      type: 'listItem',
      spread: paras.length > 1,
      children: paras.map((children): Paragraph => ({ type: 'paragraph', children })),
    })),
  }));
const taskList: fc.Arbitrary<List> = fc
  .array(fc.tuple(fc.boolean(), inline), { minLength: 1, maxLength: 3 })
  .map((items) => ({
    type: 'list',
    ordered: false,
    start: null,
    spread: false,
    children: items.map(([checked, children]): ListItem => ({
      type: 'listItem',
      spread: false,
      checked,
      children: [{ type: 'paragraph', children }],
    })),
  }));

const cell = fc.oneof(
  { weight: 3, arbitrary: inline },
  { weight: 1, arbitrary: fc.constant([] as PhrasingContent[]) }
);
const table: fc.Arbitrary<Table> = fc
  .tuple(
    fc.integer({ min: 1, max: 3 }),
    fc.boolean(),
    fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 3 })
  )
  .map(([width, withHeader, rows]) => {
    const toRow = (cells: PhrasingContent[][]): { type: 'tableRow'; children: TableCell[] } => ({
      type: 'tableRow',
      children: cells.slice(0, width).map((children) => ({ type: 'tableCell', children })),
    });
    const header = withHeader
      ? toRow(Array.from({ length: width }, (_, i) => [{ type: 'text', value: `H${i}` }]))
      : toRow(Array.from({ length: width }, () => []));
    return {
      type: 'table',
      align: Array.from({ length: width }, () => null),
      children: [header, ...rows.map(toRow)],
    };
  });

const alert: fc.Arbitrary<Alert> = fc
  .tuple(
    fc.constantFrom('note', 'tip', 'warning', 'important'),
    fc.option(plainWord, { nil: undefined }),
    fc.array(paragraph, { minLength: 1, maxLength: 2 })
  )
  .map(([kind, title, children]) => ({
    type: 'alert',
    kind,
    ...(title === undefined ? {} : { title }),
    children,
  }));

const block: fc.Arbitrary<RootContent> = fc.oneof(
  { weight: 5, arbitrary: paragraph },
  { weight: 2, arbitrary: heading },
  { weight: 1, arbitrary: code },
  { weight: 1, arbitrary: noformat },
  { weight: 1, arbitrary: rawFence },
  { weight: 1, arbitrary: leafList },
  { weight: 1, arbitrary: nestedList },
  { weight: 1, arbitrary: looseList },
  { weight: 1, arbitrary: taskList },
  { weight: 1, arbitrary: table },
  { weight: 1, arbitrary: alert as fc.Arbitrary<unknown> as fc.Arbitrary<RootContent> },
  { weight: 1, arbitrary: fc.constant<RootContent>({ type: 'thematicBreak' }) },
  { weight: 1, arbitrary: fc.constant<RootContent>({ type: 'html', value: '<br />' }) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('<!-- toc -->', '<!-- toc maxLevel=3 minLevel=1 -->')
      .map((value): RootContent => ({ type: 'html', value })),
  },
  {
    weight: 1,
    arbitrary: paragraph.map((p): RootContent => ({ type: 'blockquote', children: [p] })),
  }
);
const document = fc
  .array(block, { minLength: 1, maxLength: 6 })
  .map((children): Root => ({ type: 'root', children }))
  .map((tree) => stringifyConfluenceMarkdown(tree));

describe('property: a canonical markdown subset round-trips through storage', () => {
  it(
    'is a fixed point of md -> storage -> md, and its storage of storage -> md -> storage',
    () => {
      fc.assert(
        fc.property(document, (md) => {
          fc.pre(normalizeConfluenceMarkdown(md) === md);
          const written = markdownToStorage(md, { users });
          expect(written.warnings).toEqual([]);
          const read = storageToMarkdown(written.storage, { users });
          expect(read).toBe(md);
          const again = markdownToStorage(read, { users }).storage;
          expect(again).toBe(written.storage);
          expect(normalizeStorage(written.storage)).toBe(normalizeStorage(again));
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
