import { describe, expect, it } from 'vitest';
import { markdownToWiki, wikiToMarkdown } from './index.js';

/** wiki → markdown → wiki must return the input; these are the shapes that used to lose content. */
function roundTrip(wiki: string): { markdown: string; back: string } {
  const markdown = wikiToMarkdown(wiki);
  return { markdown, back: markdownToWiki(markdown).wiki };
}

describe('line breaks markdown cannot carry as a break', () => {
  it('keeps a break at the end of a paragraph instead of leaving a literal backslash', () => {
    const { markdown, back } = roundTrip('first paragraph\\\\\n\nsecond paragraph\n');
    expect(markdown).toBe('first paragraph<br>\n\nsecond paragraph\n');
    expect(markdown).not.toMatch(/\\\n/);
    expect(back).toBe('first paragraph\\\\\n\nsecond paragraph\n');
  });

  it('keeps a break at the end of a list item and a quote', () => {
    expect(roundTrip('* one\\\\\n').back).toBe('* one\\\\\n');
    expect(roundTrip('bq. quoted\\\\\n').back).toBe('bq. quoted\\\\\n');
  });

  it('keeps a break inside a table cell, which GFM would flatten to a space', () => {
    const { markdown, back } = roundTrip('||H||\n|a\\\\b|\n');
    expect(markdown).toBe('| H |\n| - |\n| a<br>b |\n');
    expect(back).toBe('||H||\n|a\\\\b|\n');
  });
});

describe('links the reader can produce', () => {
  it('writes back an attachment whose name contains spaces', () => {
    const wiki = 'See [^Screen Shot 2026.png] and [spec|^design notes.pdf]\n';
    const { markdown, back } = roundTrip(wiki);
    expect(markdown).toContain('attachment:Screen Shot 2026.png');
    expect(back).toBe(wiki);
  });

  it('writes back a piped link whose target contains spaces', () => {
    expect(markdownToWiki('[docs](<https://x.example.internal/a b>)\n').wiki).toBe(
      '[docs|https://x.example.internal/a b]\n'
    );
  });
});

describe('list items with no text', () => {
  it('keeps the row instead of dropping it silently', () => {
    const result = markdownToWiki('Checklist:\n\n- first\n-\n- third\n');
    expect(result.wiki).toBe('Checklist:\n\n* first\n* \n* third\n');
    expect(
      wikiToMarkdown(result.wiki)
        .split('\n')
        .filter((l) => l.startsWith('-'))
    ).toHaveLength(3);
  });
});
