import type { Paragraph, Root, RootContent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { decodeParams, encodeParams } from '../params.js';
import {
  normalizeConfluenceMarkdown,
  parseConfluenceMarkdown,
  stringifyConfluenceMarkdown,
} from './index.js';

const parse = parseConfluenceMarkdown;
/** Positions are noise for shape assertions. */
function strip<T>(node: T): T {
  return JSON.parse(
    JSON.stringify(node, (key, value) => (key === 'position' ? undefined : value))
  ) as T;
}
const first = (md: string): RootContent => strip(parse(md).children[0] as RootContent);
const inline = (md: string): Paragraph['children'] => (first(md) as Paragraph).children;
const roundTrip = (md: string): string => stringifyConfluenceMarkdown(parse(md));

describe('params', () => {
  it('encodes and decodes key=value words, quoting when needed', () => {
    const pairs: Array<[string, string]> = [
      ['language', 'js'],
      ['title', 'My file.js'],
      ['empty', ''],
      ['q', 'say "hi"'],
    ];
    const text = encodeParams(pairs);
    expect(text).toBe('language=js title="My file.js" empty="" q="say \\"hi\\""');
    expect(decodeParams(text)).toEqual(pairs);
    expect(decodeParams('  a=1   b=2 ')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('rejects text outside the grammar', () => {
    expect(decodeParams('thumbnail')).toBeUndefined();
    expect(decodeParams('a=')).toBeUndefined();
    expect(decodeParams('a="unterminated')).toBeUndefined();
    expect(decodeParams('1a=b')).toBeUndefined();
    expect(decodeParams('a="x"y')).toBeUndefined();
  });
});

describe('[[page links]]', () => {
  it.each([
    ['[[Release notes]]', { title: 'Release notes' }],
    ['[[DEV:Release notes]]', { space: 'DEV', title: 'Release notes' }],
    [
      '[[DEV:Release notes|the notes]]',
      { space: 'DEV', title: 'Release notes', body: 'the notes' },
    ],
    ['[[:Release:notes]]', { space: '', title: 'Release:notes' }],
    ['[[~jsmith:Home]]', { space: '~jsmith', title: 'Home' }],
  ])('%s parses and round-trips', (md, expected) => {
    expect(inline(`${md}\n`)[0]).toMatchObject({ type: 'pageLink', ...expected });
    expect(roundTrip(`see ${md} now\n`)).toBe(`see ${md} now\n`);
  });

  it('leaves escaped, unterminated and ordinary brackets alone', () => {
    expect(inline('\\[\\[x]]\n')).toEqual([{ type: 'text', value: '[[x]]' }]);
    expect(roundTrip('\\[\\[x]]\n')).toBe('\\[\\[x]]\n');
    expect(inline('[[a\n')).toEqual([{ type: 'text', value: '[[a' }]);
    expect(inline('[[]] and [x]\n').map((n) => n.type)).toEqual(['text']);
    expect(roundTrip('[x]\n')).toBe('\\[x]\n');
  });

  it('guards a bare title that looks like SPACE:Title on write', () => {
    const tree: Root = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'pageLink', title: 'Release:notes' }] }],
    };
    expect(stringifyConfluenceMarkdown(tree)).toBe('[[:Release:notes]]\n');
  });
});

describe('{jira:KEY}', () => {
  it('parses a key with and without parameters and round-trips', () => {
    expect(inline('{jira:PROJ-1}\n')[0]).toEqual({ type: 'jiraMacro', key: 'PROJ-1', params: [] });
    expect(inline('{jira:PROJ_2-42 serverId=abc columns="key,summary"}\n')[0]).toEqual({
      type: 'jiraMacro',
      key: 'PROJ_2-42',
      params: [
        ['serverId', 'abc'],
        ['columns', 'key,summary'],
      ],
    });
    expect(roundTrip('a {jira:PROJ-1} b {jira:PROJ-2 serverId=abc}\n')).toBe(
      'a {jira:PROJ-1} b {jira:PROJ-2 serverId=abc}\n'
    );
  });

  it('keeps malformed and escaped macros as text', () => {
    expect(inline('{jira:proj-1} {jira:PROJ} {jira:PROJ-1\n')).toEqual([
      { type: 'text', value: '{jira:proj-1} {jira:PROJ} {jira:PROJ-1' },
    ]);
    expect(inline('\\{jira:PROJ-1}\n')).toEqual([{ type: 'text', value: '{jira:PROJ-1}' }]);
    expect(roundTrip('\\{jira:PROJ-1}\n')).toBe('\\{jira:PROJ-1}\n');
  });
});

describe('[!NOTE] alerts', () => {
  it('turns a blockquote opening with a marker into an alert with title and body', () => {
    const node = first('> [!NOTE] Mind the gap\n> First line\n> second line\n>\n> - item\n');
    expect(node).toMatchObject({
      type: 'alert',
      kind: 'note',
      title: 'Mind the gap',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'First line\nsecond line' }] },
        { type: 'list' },
      ],
    });
  });

  it('handles every kind, no title, no body and a non-paragraph first block', () => {
    expect(first('> [!TIP]\n> body\n')).toMatchObject({
      type: 'alert',
      kind: 'tip',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'body' }] }],
    });
    expect((first('> [!TIP]\n> body\n') as { title?: string }).title).toBeUndefined();
    expect(first('> [!WARNING] Only a title\n')).toMatchObject({
      type: 'alert',
      kind: 'warning',
      title: 'Only a title',
      children: [],
    });
    expect(first('> [!IMPORTANT]\n>\n> ```\n> code\n> ```\n')).toMatchObject({
      type: 'alert',
      kind: 'important',
      children: [{ type: 'code', value: 'code' }],
    });
    expect(first('> [!CAUTION] x\n')).toMatchObject({ type: 'alert', kind: 'caution' });
  });

  it('leaves escaped and mid-paragraph markers as text and plain quotes untouched', () => {
    expect(first('> \\[!NOTE] x\n')).toMatchObject({
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!NOTE] x' }] }],
    });
    expect(inline('see [!NOTE] here\n')).toEqual([{ type: 'text', value: 'see [!NOTE] here' }]);
    expect(first('> plain\n')).toMatchObject({ type: 'blockquote' });
    expect(first('[!NOTE] top\n')).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'text', value: '[!NOTE] top' }],
    });
  });

  it.each([
    '> [!NOTE] Mind the gap\n> First line\n> second line\n>\n> - item\n',
    '> [!TIP]\n> body\n',
    '> [!WARNING] Only a title\n',
    '> [!IMPORTANT]\n>\n> ```\n> code\n> ```\n',
    '> \\[!NOTE] literal\n',
    '\\[!NOTE] top\n',
  ])('round-trips %j', (md) => {
    expect(roundTrip(md)).toBe(md);
  });
});

describe('@{userkey:…}', () => {
  it('parses the placeholder next to ordinary mentions and round-trips both', () => {
    expect(inline('@{userkey:abc123} and @jsmith\n')).toEqual([
      { type: 'mention', username: '', userKey: 'abc123' },
      { type: 'text', value: ' and ' },
      { type: 'mention', username: 'jsmith' },
    ]);
    expect(roundTrip('@{userkey:abc123} and @jsmith\n')).toBe('@{userkey:abc123} and @jsmith\n');
  });

  it('respects the left boundary and keeps escaped or malformed forms as text', () => {
    expect(inline('x@{userkey:abc}\n')).toEqual([{ type: 'text', value: 'x@{userkey:abc}' }]);
    expect(inline('@{userkey:}\n')).toEqual([{ type: 'text', value: '@{userkey:}' }]);
    expect(inline('\\@{userkey:abc}\n')).toEqual([{ type: 'text', value: '@{userkey:abc}' }]);
    expect(roundTrip('\\@{userkey:abc}\n')).toBe('\\@{userkey:abc}\n');
    expect(roundTrip('jane@example.internal\n')).toBe('jane@example.internal\n');
  });
});

it('normalizeConfluenceMarkdown is idempotent on a document using every construct', () => {
  const md =
    '# Title\n\nSee [[DEV:Design|the design]], {jira:PROJ-1 serverId=abc} and @{userkey:k1} with @jsmith.\n\n> [!NOTE] Heads up\n> Body with `code`.\n\n- [ ] task\n- [x] done\n';
  expect(normalizeConfluenceMarkdown(md)).toBe(md);
});
