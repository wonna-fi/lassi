import { parseMarkdown } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { createWikiConverter, markdownToWiki, mdastToWiki, wikiToMarkdown } from './index.js';

const markdown = 'Paragraph.\n\n## Heading\n\nBody.\n';
const spaced = 'Paragraph.\n\n&nbsp;\n\nh2. Heading\n\nBody.\n';
const unspaced = 'Paragraph.\n\nh2. Heading\n\nBody.\n';

describe('heading spacers', () => {
  it.each([1, 2, 3, 4, 5, 6])('spaces heading level %i without changing its text', (depth) => {
    const source = `Paragraph.\n\n${'#'.repeat(depth)} **Heading** and *text*\n`;
    const result = markdownToWiki(source);
    expect(result).toEqual({
      wiki: `Paragraph.\n\n&nbsp;\n\nh${depth}. *Heading* and _text_\n`,
      warnings: [],
    });
    expect(wikiToMarkdown(result.wiki)).toBe(source);
  });

  it.each([
    ['paragraph', 'Text', 'Text'],
    ['list', '- Item', '* Item'],
    ['table', '| H |\n| - |\n| Cell |', '||H||\n|Cell|'],
    ['code', '```ts\nx\n```', '{code:ts}\nx\n{code}'],
    ['noformat', '```noformat\nx\n```', '{noformat}\nx\n{noformat}'],
    ['quote', '> Text', 'bq. Text'],
    ['heading', '# First', 'h1. First'],
    ['rule', '---', '----'],
  ])('spaces a heading after a %s', (_name, before, expected) => {
    expect(markdownToWiki(`${before}\n\n## Next\n`).wiki).toBe(
      `${expected}\n\n&nbsp;\n\nh2. Next\n`
    );
  });

  it('does not add leading spacing, including after non-rendering definitions', () => {
    expect(markdownToWiki('[ref]: https://example.com\n\n# First\n').wiki).toBe('h1. First\n');
    expect(markdownToWiki('> # First\n>\n> ## Second\n').wiki).toBe(
      '{quote}\nh1. First\n\n&nbsp;\n\nh2. Second\n{quote}\n'
    );
    expect(markdownToWiki('Text\n\n[ref]: https://example.com\n\n# Next\n').wiki).toBe(
      'Text\n\n&nbsp;\n\nh1. Next\n'
    );
  });

  it('spaces headings inside quotes and headings hoisted out of lists', () => {
    const quoted = '> Text\n>\n> ## Heading\n';
    const result = markdownToWiki(quoted);
    expect(result.wiki).toBe('{quote}\nText\n\n&nbsp;\n\nh2. Heading\n{quote}\n');
    expect(wikiToMarkdown(result.wiki)).toBe(quoted);
    const list = markdownToWiki('- Item\n\n  ## Heading\n');
    expect(list.wiki).toBe('* Item\n\n&nbsp;\n\nh2. Heading\n');
    expect(list.warnings.map((warning) => warning.code)).toEqual(['list-split']);
  });

  it.each([
    ['raw spacer', '```jira\n&nbsp;\n```', '&nbsp;'],
    ['non-breaking space', '&nbsp;', '\u00a0'],
    ['break', '<br>', '\\\\'],
    ['self-closing break', '<br />', '\\\\'],
    ['uppercase break', '<BR>', '\\\\'],
    ['multiple breaks', '<br><br>', '\\\\\\\\'],
  ])('reuses an existing %s', (_name, spacer, rendered) => {
    const expected = `Text\n\n${rendered}\n\nh2. Heading\n`;
    expect(markdownToWiki(`Text\n\n${spacer}\n\n## Heading\n`).wiki).toBe(expected);
    expect(markdownToWiki(wikiToMarkdown(expected)).wiki).toBe(
      expected.replace('\u00a0', '&nbsp;')
    );
  });

  it('preserves authored trailing breaks while adding heading spacing', () => {
    const result = markdownToWiki('Text<br>\n\n## Heading\n');
    expect(result.wiki).toBe('Text\\\\\n\n&nbsp;\n\nh2. Heading\n');
    expect(wikiToMarkdown(result.wiki)).toBe('Text<br>\n\n## Heading\n');
  });

  it.each(['', 'ts', 'noformat', 'jira'])('never rewrites headings inside a %s fence', (lang) => {
    const body = 'Text\n\n&nbsp;\n\nh2. Literal';
    const expected =
      lang === 'jira'
        ? body
        : `${lang === 'noformat' ? '{noformat}' : lang ? `{code:${lang}}` : '{code}'}\n${body}\n${lang === 'noformat' ? '{noformat}' : '{code}'}`;
    expect(markdownToWiki(`\`\`\`${lang}\n${body}\n\`\`\`\n`).wiki).toBe(`${expected}\n`);
  });

  it('forwards the opt-out through every converter entry point', () => {
    expect(markdownToWiki(markdown).wiki).toBe(spaced);
    expect(mdastToWiki(parseMarkdown(markdown)).wiki).toBe(spaced);
    expect(createWikiConverter().fromMarkdown(markdown)).toBe(spaced);
    const opts = { headingSpacers: false };
    expect(markdownToWiki(markdown, opts).wiki).toBe(unspaced);
    expect(mdastToWiki(parseMarkdown(markdown), opts).wiki).toBe(unspaced);
    const converter = createWikiConverter(opts);
    expect(converter.fromMarkdown(markdown)).toBe(unspaced);
    expect(converter.toMarkdown(spaced)).toBe(markdown);
    expect(markdownToWiki('> Text\n>\n> ## Heading\n', opts).wiki).toBe(
      '{quote}\nText\n\nh2. Heading\n{quote}\n'
    );
  });

  it('normalizes repeated spacers and reaches a fixed point', () => {
    let source = spaced.replace('&nbsp;', '&nbsp;\n\n &nbsp; ');
    for (let i = 0; i < 3; i++) {
      expect(wikiToMarkdown(source)).toBe(markdown);
      source = markdownToWiki(wikiToMarkdown(source)).wiki;
      expect(source).toBe(spaced);
    }
    expect(wikiToMarkdown('&nbsp;\n\nh1. First\n')).toBe('# First\n');
    expect(wikiToMarkdown(spaced.replaceAll('\n', '\r\n'))).toBe(markdown);
  });

  it('keeps entities that are not heading spacer paragraphs', () => {
    expect(wikiToMarkdown('Text &nbsp; here\n\nh2. Heading\n')).toBe(
      'Text \\&nbsp; here\n\n## Heading\n'
    );
    expect(wikiToMarkdown('&nbsp;\n\nText\n')).toBe('\\&nbsp;\n\nText\n');
    expect(wikiToMarkdown('&nbsp;\ncontinued\n\nh2. Heading\n')).toBe(
      '\\&nbsp;\\\ncontinued\n\n## Heading\n'
    );
    for (const macro of ['code', 'noformat', 'panel']) {
      const source = `{${macro}}\n&nbsp;\n\nh2. Literal\n{${macro}}\n`;
      expect(markdownToWiki(wikiToMarkdown(source)).wiki).toBe(source);
    }
  });
});
