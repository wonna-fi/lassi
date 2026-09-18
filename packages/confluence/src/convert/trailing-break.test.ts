import { describe, expect, it } from 'vitest';
import { createStorageConverter } from './index.js';

const converter = createStorageConverter();

describe('a break at the end of a run', () => {
  it('round-trips as inline HTML instead of leaving a literal backslash in the page', () => {
    const markdown = converter.toMarkdown('<p>text<br /></p>');
    expect(markdown).toBe('text<br />\n');
    expect(markdown).not.toMatch(/\\\n/);
    expect(converter.fromMarkdown(markdown)).toBe('<p>text<br /></p>');
  });

  it('does the same inside a task body', () => {
    const storage =
      '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body><span class="placeholder-inline-tasks">text<br /></span></ac:task-body>' +
      '</ac:task></ac:task-list>';
    const markdown = converter.toMarkdown(storage);
    expect(markdown).toBe('- [ ] text<br />\n');
    expect(converter.fromMarkdown(markdown)).toBe(storage);
  });

  it('still carries a break in the middle of a paragraph as a hard break', () => {
    expect(converter.toMarkdown('<p>a<br />b</p>')).toBe('a\\\nb\n');
    expect(converter.fromMarkdown('a\\\nb\n')).toBe('<p>a<br />b</p>');
  });
});
