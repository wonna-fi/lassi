import { describe, expect, it } from 'vitest';
import { createStorageConverter } from './index.js';
import { DEFAULT_WRITER_OPTIONS, inferWriterOptionsFromStorage } from './writer-options.js';
import { storageToMdast } from './storage-to-mdast.js';

/** Reads a page, then writes it back the way that page is written. */
function roundTrip(storage: string): { markdown: string; back: string } {
  const converter = createStorageConverter({ writer: inferWriterOptionsFromStorage(storage) });
  const markdown = converter.toMarkdown(storage);
  return { markdown, back: converter.fromMarkdown(markdown) };
}

describe('a URL that is its own label', () => {
  it('keeps the anchor the editor wrote instead of flattening it to text', () => {
    const storage =
      '<p>See <a href="https://x.example.internal/docs">https://x.example.internal/docs</a> now.</p>';
    const { markdown, back } = roundTrip(storage);
    expect(markdown).toBe('See https://x.example.internal/docs now.\n');
    expect(back).toBe(storage);
  });

  it('leaves a page whose URLs are plain text as plain text', () => {
    const storage = '<p>See https://x.example.internal/docs now.</p>';
    expect(roundTrip(storage).back).toBe(storage);
  });

  it('follows the majority on a mixed page', () => {
    const anchors =
      '<p><a href="https://a.example.internal">https://a.example.internal</a> and ' +
      '<a href="https://b.example.internal">https://b.example.internal</a> and https://c.example.internal</p>';
    expect(inferWriterOptionsFromStorage(anchors).autolink).toBe('anchor');
    expect(inferWriterOptionsFromStorage('<p>https://c.example.internal</p>').autolink).toBe(
      'text'
    );
  });

  it('keeps the default on a tie, whichever shape it saw first', () => {
    // The tally started at zero, so the first value seen won a tie: one wrapped table and one plain
    // table wrote both back as wrapped, depending only on the order they appeared in.
    const wrappedFirst =
      '<table class="wrapped"><tbody><tr><td>a</td></tr></tbody></table>' +
      '<table><tbody><tr><td>b</td></tr></tbody></table>';
    const plainFirst =
      '<table><tbody><tr><td>a</td></tr></tbody></table>' +
      '<table class="wrapped"><tbody><tr><td>b</td></tr></tbody></table>';
    const shell = inferWriterOptionsFromStorage(wrappedFirst).tableShell;
    expect(shell).toBe(inferWriterOptionsFromStorage(plainFirst).tableShell);
    expect(shell).toBe(DEFAULT_WRITER_OPTIONS.tableShell);
  });
});

describe('task bodies', () => {
  it('keeps a body that has no placeholder span', () => {
    const storage =
      '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body>plain text</ac:task-body></ac:task></ac:task-list>';
    const { markdown, back } = roundTrip(storage);
    expect(markdown).toBe('- [ ] plain text\n');
    expect(back).toBe(storage);
  });

  it('escalates a styled span in a task body instead of dropping the style', () => {
    const storage =
      '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body><span style="color: rgb(255,0,0);">urgent</span></ac:task-body></ac:task></ac:task-list>';
    const result = storageToMdast(storage);
    expect(result.warnings.map((w) => w.code)).toContain('inline-unknown');
    expect(createStorageConverter().toMarkdown(storage)).toContain('```confluence');
  });
});

describe('blocks inside one list item', () => {
  it('separates them, so a rule does not re-read as a heading', () => {
    const storage = '<ul><li><p>Decision made</p><hr /></li></ul>';
    const { markdown, back } = roundTrip(storage);
    expect(markdown).toBe('- Decision made\n\n  ---\n');
    expect(back).toBe(storage);
  });

  it('keeps a nested list tight', () => {
    const storage = '<ul><li>two<ul><li>two-a</li></ul></li></ul>';
    expect(roundTrip(storage).markdown).toBe('- two\n  - two-a\n');
  });
});

describe('an image attached to another page', () => {
  it('is fenced rather than retargeted at this page', () => {
    const storage =
      '<p><ac:image ac:alt="a"><ri:attachment ri:filename="x.png">' +
      '<ri:page ri:space-key="OTHER" ri:content-title="Other page" /></ri:attachment></ac:image></p>';
    const markdown = createStorageConverter().toMarkdown(storage);
    expect(markdown).toContain('```confluence');
    expect(markdown).toContain('ri:page');
    expect(markdown).not.toContain('attachment:x.png');
  });
});

describe('a processing instruction', () => {
  it('is fenced with its closing bracket, so the fence does not swallow what follows', () => {
    const storage = '<?xml version="1.0"?><p>a</p>';
    const converter = createStorageConverter();
    const markdown = converter.toMarkdown(storage);
    expect(markdown).toContain('<?xml version="1.0"?>');
    expect(converter.fromMarkdown(markdown)).toBe(storage);
  });
});
