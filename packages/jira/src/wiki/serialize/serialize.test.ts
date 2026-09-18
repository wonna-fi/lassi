import { LassiError, parseMarkdown } from '@wonna/lassi-core';
import type { Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { createWikiConverter, wikiToMarkdown } from '../index.js';
import { escapeWikiText, type EscapeContext } from './escape.js';
import { collectMentions, markdownToWiki, mdastToWiki } from './index.js';
import { Warnings } from './warnings.js';

const wiki = (md: string): string => markdownToWiki(md).wiki;
const codes = (md: string): string[] => markdownToWiki(md).warnings.map((w) => w.code);

function failure(run: () => unknown): LassiError {
  try {
    run();
  } catch (err) {
    return err as LassiError;
  }
  throw new Error('expected a failure');
}

function esc(text: string, ctx: Partial<EscapeContext> = {}): string {
  return escapeWikiText(text, {
    out: '',
    rest: '',
    lineStart: true,
    paragraphStart: true,
    inTableCell: false,
    closerMarkers: [],
    warnings: new Warnings(),
    ...ctx,
  });
}

describe('escapeWikiText', () => {
  it.each([
    ['{{not code}}', '\\{{not code}}'],
    ['{code} and {code:java}', '\\{code} and \\{code:java}'],
    ['{not a macro} {unterminated', '{not a macro} {unterminated'],
    ['{*}x{*}', '\\{\\*}x\\{*}'],
    ['[1] and [ x ] and [no close', '\\[1] and [ x ] and [no close'],
    ['*not bold*', '\\*not bold*'],
    ['* not bold *', '\\* not bold *'],
    ['foo*bar and 2*3 and snake_case', 'foo*bar and 2*3 and snake_case'],
    ['a lone * star', 'a lone * star'],
    ['_private and __init__', '\\_private and __init__'],
    ['-1 -v C++ i++ e^2^ H~2~O', '-1 -v C++ i++ e^2^ H~2~O'],
    ['??cite?? and what??', '\\??cite?? and what??'],
    ['Wow!Nice! and Hello!world and (!)', 'Wow\\!Nice! and Hello!world and (!)'],
    ['!x.png! and !not an image!', '\\!x.png! and !not an image!'],
    ['* not a list', '\\* not a list'],
    ['** not a list', '\\** not a list'],
    ['# not a list', '\\# not a list'],
    ['#1 priority', '#1 priority'],
    ['- not a list', '\\- not a list'],
    ['----', '\\----'],
    ['--- three dashes', '--- three dashes'],
    ['|pipe start', '\\|pipe start'],
    ['C:\\dir\\f.txt', 'C:\\dir\\f.txt'],
  ])('%j → %j', (input, expected) => {
    expect(esc(input)).toBe(expected);
  });

  it('applies the line-start guards only at the start of a line', () => {
    expect(esc('* x', { out: 'a ' })).toBe('* x');
    expect(esc('* not bold *', { lineStart: false, paragraphStart: false })).toBe('* not bold *');
    expect(esc('|x', { lineStart: false })).toBe('|x');
  });

  it('escapes pipes and a trailing backslash inside table cells', () => {
    const cell = { lineStart: false, paragraphStart: false, inTableCell: true };
    expect(esc('a | b || c', cell)).toBe('a &#124; b &#124;&#124; c');
    expect(esc('end\\', cell)).toBe('end&#92;');
  });

  it('turns a backslash before a special character into an entity, with a warning', () => {
    const warnings = new Warnings();
    expect(esc('a\\*b and c\\\\d', { warnings })).toBe('a&#92;*b and c&#92;\\d');
    expect(warnings.list.map((w) => w.code)).toEqual(['backslash-entity', 'backslash-entity']);
  });

  it('looks at the line so far and the rest of the line', () => {
    expect(esc('see [1', { rest: ']', lineStart: false, paragraphStart: false })).toBe('see \\[1');
    expect(esc('*a', { rest: ' b*', lineStart: false, paragraphStart: false })).toBe('\\*a');
    expect(esc('*a', { rest: ' b', lineStart: false, paragraphStart: false })).toBe('*a');
    expect(esc('x', { out: 'a{', rest: '{y}}', lineStart: false, paragraphStart: false })).toBe(
      'x'
    );
  });

  it('escapes closer-position markers of the enclosing emphasis', () => {
    const inner = { lineStart: false, paragraphStart: false, closerMarkers: ['*'] };
    expect(esc('a* b', inner)).toBe('a\\* b');
    expect(esc('a*b', inner)).toBe('a*b');
  });

  it('refuses a paragraph whose first line starts like a heading or bq', () => {
    expect(failure(() => esc('h1. x')).code).toBe('validation');
    expect(failure(() => esc('bq. x')).hint).toMatch(/jira fence/);
    expect(esc('h1. x', { paragraphStart: false })).toBe('h1. x');
  });
});

describe('markdownToWiki', () => {
  it('returns an empty string for an empty document', () => {
    expect(wiki('')).toBe('');
  });

  it('chooses the plain or the intra-word emphasis form by the neighbours', () => {
    expect(wiki('a**b**c and (**x**) and **y**, and `c`**z** and ***n***\n')).toBe(
      'a{*}b{*}c and (*x*) and *y*, and {{c}}{*}z{*} and _*n*_\n'
    );
  });

  it('moves edge whitespace outside the markers and drops empty emphasis', () => {
    const tree = parseMarkdown('x\n');
    tree.children = [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'a' },
          { type: 'strong', children: [{ type: 'text', value: ' b ' }] },
          { type: 'emphasis', children: [{ type: 'text', value: '  ' }] },
          { type: 'text', value: 'c' },
        ],
      },
    ];
    expect(mdastToWiki(tree).wiki).toBe('a *b*   c\n');
  });

  it('refuses the intra-word form only when markup inside it carries the closer tag', () => {
    expect(wiki('a**x {\\*} y**b\n')).toBe('a{*}x \\{\\*} y{*}b\n');
    expect(failure(() => wiki('a**x [{*}](https://x.example.com) y**b\n')).message).toMatch(
      /\{\*\}/
    );
  });

  it('writes hard breaks as newlines only where the reader rejoins the lines', () => {
    expect(wiki('a\\\nb\n')).toBe('a\nb\n');
    expect(wiki('a \\\nb\n')).toBe('a \\\\b\n');
    expect(wiki('a\\\nh1. b\n')).toBe('a\\\\h1. b\n');
    expect(wiki('a\\\nbq. b\n')).toBe('a\\\\bq. b\n');
    expect(wiki('a\\\n\\\nb\n')).toBe('a\\\\\\\\b\n');
    expect(wiki('**a\\\nb**\n')).toBe('*a\\\\b*\n');
    expect(wiki('a<br>b<br/>c<br />d\n')).toBe('a\nb\nc\nd\n');
  });

  it('collapses soft breaks to spaces', () => {
    expect(wiki('a\nb\n')).toBe('a b\n');
  });

  it('reads a break inside a Jira heading as a space, since markdown headings have none', () => {
    expect(wikiToMarkdown('h1. a\\\\b\n')).toBe('# a b\n');
  });

  it('writes code blocks', () => {
    expect(wiki('```\nx\n```\n')).toBe('{code}\nx\n{code}\n');
    expect(wiki('```ts\nx\n```\n')).toBe('{code:ts}\nx\n{code}\n');
    expect(wiki('```noformat\n*x*\n```\n')).toBe('{noformat}\n*x*\n{noformat}\n');
    expect(wiki('```jira\n{panel}x{panel}\n```\n')).toBe('{panel}x{panel}\n');
    expect(wiki('```\n\nx\n\n```\n')).toBe('{code}\n\nx\n\n{code}\n');
    const closer = markdownToWiki('```java\nfoo {code} bar\n```\n');
    expect(closer.wiki).toBe('{noformat}\nfoo {code} bar\n{noformat}\n');
    expect(closer.warnings.map((w) => w.code)).toEqual(['code-closer-in-body']);
    expect(codes('```ts title=x\ny\n```\n')).toEqual(['code-meta-dropped']);
    expect(failure(() => wiki('```noformat\n{noformat}\n```\n')).code).toBe('validation');
    expect(failure(() => wiki('```java\n{code} {noformat}\n```\n')).code).toBe('validation');
    expect(failure(() => wiki('```lang=ts\nx\n```\n')).message).toMatch(/language/);
  });

  it('writes inline code and refuses values it cannot close', () => {
    expect(wiki('`a{b}c`\n')).toBe('{{a{b}c}}\n');
    expect(failure(() => wiki('`a}}b`\n')).message).toMatch(/inline code/);
    expect(failure(() => wiki('`a}`\n')).hint).toMatch(/fenced/);
  });

  it('writes links, autolinks, images and mentions', () => {
    expect(
      wiki(
        '[t](https://x.example.com) and https://x.example.com and jane@example.internal and @jsmith\n'
      )
    ).toBe(
      '[t|https://x.example.com] and https://x.example.com and jane@example.internal and [~jsmith]\n'
    );
    expect(wiki('a[x](https://x.example.com) and a<https://x.example.com>\n')).toBe(
      'a[x|https://x.example.com] and a[https://x.example.com|https://x.example.com]\n'
    );
    expect(
      wiki(
        '![a](attachment:a.png) ![b](attachment:b.png "thumbnail") ![c](https://x.example.com/c.png)\n'
      )
    ).toBe('!a.png! !b.png|thumbnail! !https://x.example.com/c.png!\n');
    expect(failure(() => wiki('![a](attachment:noext)\n')).message).toMatch(/extension/);
    expect(failure(() => wiki('![a](attachment:a.png "bad param")\n')).message).toMatch(
      /image parameter/
    );
    expect(failure(() => wiki('![a](ftp://x.example.com/a.png)\n')).hint).toMatch(/attachment:/);
    expect(failure(() => wiki('[a](https://x.example.com/a|b)\n')).message).toMatch(
      /may not contain/
    );
  });

  it('resolves reference links and rejects unresolved ones', () => {
    expect(wiki('[a][r] and ![i][p]\n\n[r]: https://x.example.com\n[p]: attachment:p.png\n')).toBe(
      '[a|https://x.example.com] and !p.png!\n'
    );
    const tree = parseMarkdown('x\n');
    tree.children = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'linkReference',
            identifier: 'nope',
            label: 'nope',
            referenceType: 'full',
            children: [{ type: 'text', value: 'a' }],
          },
        ],
      },
    ];
    expect(failure(() => mdastToWiki(tree)).message).toMatch(/no definition/);
  });

  it('maps colour spans both ways and rejects any other HTML', () => {
    expect(wiki('a <span style="color:red">b</span> c\n')).toBe('a {color:red}b{color} c\n');
    expect(wiki('<span style="color:#00FF00">x *y*</span>\n')).toBe(
      '{color:#00FF00}x _y_{color}\n'
    );
    expect(failure(() => wiki('<span style="color:rgb(1,2,3)">x</span>\n')).hint).toMatch(/#rgb/);
    expect(failure(() => wiki('<span style="color:red">x\n')).message).toMatch(/matching/);
    expect(failure(() => wiki('a</span>\n')).message).toMatch(/without a matching/);
    expect(failure(() => wiki('<span style="color:red"> </span>\n')).message).toMatch(/empty/);
    expect(failure(() => wiki('<b>x</b>\n')).hint).toMatch(/jira fence/);
    expect(failure(() => wiki('<div>\nx\n</div>\n')).message).toMatch(/HTML blocks/);
  });

  it('writes quotes: one line as bq., anything else as a {quote} block', () => {
    expect(wiki('> one line\n')).toBe('bq. one line\n');
    expect(wiki('> a\n>\n> b\n')).toBe('{quote}\na\n\nb\n{quote}\n');
    expect(wiki('> a\\\n> b\n')).toBe('{quote}\na\nb\n{quote}\n');
    const nested = markdownToWiki('> a\n>\n> > b\n');
    expect(nested.wiki).toBe('{quote}\na\n\nb\n{quote}\n');
    expect(nested.warnings.map((w) => w.code)).toEqual(['quote-flattened']);
    expect(failure(() => wiki('> a\n>\n> ```jira\n> {quote}x{quote}\n> ```\n')).hint).toMatch(
      /jira fence/
    );
  });

  it('writes tables with padded cells and rejects rows wider than the header', () => {
    expect(wiki('| a | b |\n| - | - |\n| c | |\n| d |\n')).toBe('||a||b||\n|c| |\n|d| |\n');
    const tree = parseMarkdown('x\n');
    tree.children = [
      {
        type: 'table',
        align: [null],
        children: [
          { type: 'tableRow', children: [{ type: 'tableCell', children: [] }] },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [] },
              { type: 'tableCell', children: [] },
            ],
          },
        ],
      },
    ];
    expect(failure(() => mdastToWiki(tree)).message).toMatch(/wider/);
  });

  it('rejects footnotes and unknown nodes', () => {
    expect(failure(() => wiki('a[^1]\n\n[^1]: note\n')).message).toMatch(/footnotes/);
    const tree = parseMarkdown('x\n');
    tree.children = [{ type: 'math', value: 'x' } as unknown as Root['children'][number]];
    expect(failure(() => mdastToWiki(tree)).message).toMatch(/unsupported markdown node: math/);
  });

  it('collects mentions once each, in document order', () => {
    expect(collectMentions(parseMarkdown('@b and @a and **@b**\n'))).toEqual(['b', 'a']);
  });

  it('wraps both directions as a BodyConverter and forwards warnings', () => {
    const seen: string[] = [];
    const converter = createWikiConverter({ onWarning: (w) => seen.push(w.code) });
    expect(converter.format).toBe('wiki');
    expect(converter.toMarkdown('h1. x\n')).toBe('# x\n');
    expect(converter.fromMarkdown('3. a\n')).toBe('# a\n');
    expect(seen).toEqual(['list-start-dropped']);
  });
});
