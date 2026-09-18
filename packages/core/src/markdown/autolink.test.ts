import { describe, expect, it } from 'vitest';
import { normalizeMarkdown, parseMarkdown } from './index.js';

function urlOf(markdown: string): string | undefined {
  const paragraph = parseMarkdown(markdown).children[0];
  if (paragraph?.type !== 'paragraph') return undefined;
  const link = paragraph.children.find((child) => child.type === 'link');
  return link?.type === 'link' ? link.url : undefined;
}

describe('bare autolink literals', () => {
  it('do not absorb the escape of the character that follows them', () => {
    const source = 'See https://jira.example.internal/browse/PROJ-1* for details\n';
    const once = normalizeMarkdown(source);
    expect(once).toBe(normalizeMarkdown(once));
    expect(urlOf(once)).toBe('https://jira.example.internal/browse/PROJ-1');
    expect(urlOf(normalizeMarkdown(once))).toBe('https://jira.example.internal/browse/PROJ-1');
  });

  it('stay bare where nothing after them can grow a backslash', () => {
    for (const source of [
      'bare https://y.example.internal and jane@example.internal.\n',
      'see https://y.example.internal/a_b\n',
      'ends the line https://y.example.internal\n',
    ]) {
      const out = normalizeMarkdown(source);
      expect(out).toBe(source);
      expect(out).not.toContain('<http');
    }
  });
});
