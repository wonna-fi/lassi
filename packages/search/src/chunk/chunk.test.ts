import { describe, expect, it } from 'vitest';
import { chunkDocument, docMetaFromFrontmatter } from './chunk.js';

const ISSUE = `---
key: PROJ-123
summary: Login page throws 500 on empty password
type: Bug
priority: High
assignee: jsmith
labels:
  - auth
  - regression
readonly:
  status: In Progress
  url: https://jira.example.internal/browse/PROJ-123
counts: { comments: 2, attachments: 0, links: 1 }
lassi: { fetchedAt: 2026-09-04T10:00:00.000Z, product: jira, schema: 1 }
---

Intro paragraph before any heading.

## Steps

1. one
2. two

\`\`\`ts
const a = 1;
\`\`\`

### Detail

Nested detail text.

## Expected

Works.
`;

describe('chunkDocument', () => {
  it('starts with a metadata chunk, then one chunk per heading section with the heading path', () => {
    const doc = chunkDocument(ISSUE, { maxChars: 1500, overlap: 200 });
    expect(doc.meta).toEqual({
      product: 'jira',
      ref: 'PROJ-123',
      title: 'Login page throws 500 on empty password',
      url: 'https://jira.example.internal/browse/PROJ-123',
    });
    expect(doc.chunks.map((c) => [c.ordinal, c.heading])).toEqual([
      [0, ''],
      [1, ''],
      [2, 'Steps'],
      [3, 'Steps > Detail'],
      [4, 'Expected'],
    ]);
    expect(doc.chunks[0]?.text).toBe(
      'jira PROJ-123: Login page throws 500 on empty password | type: Bug | status: In Progress | priority: High | assignee: jsmith | labels: auth, regression'
    );
    expect(doc.chunks[1]?.text).toBe('Intro paragraph before any heading.');
    expect(doc.chunks[2]?.text).toBe('## Steps\n\n1. one\n2. two\n\n```ts\nconst a = 1;\n```');
    expect(doc.chunks[2]?.embedText).toBe(
      'Login page throws 500 on empty password — Steps\n## Steps\n\n1. one\n2. two\n\n```ts\nconst a = 1;\n```'
    );
    expect(doc.chunks[3]?.text).toBe('### Detail\n\nNested detail text.');
  });

  it('indexes a bodiless document through its metadata chunk alone', () => {
    const doc = chunkDocument(
      '---\nid: 123456\ntitle: Empty page\nspace: DEV\natl: { product: confluence }\n---\n',
      {
        maxChars: 500,
        overlap: 50,
      }
    );
    expect(doc.meta).toEqual({ product: 'confluence', ref: '123456', title: 'Empty page' });
    expect(doc.chunks).toHaveLength(1);
    expect(doc.chunks[0]?.text).toBe('confluence 123456: Empty page | space: DEV');
  });

  it('splits an oversized section at blank lines and carries the overlap forward', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) =>
      `Paragraph ${i} ${'word '.repeat(30)}`.trim()
    );
    const md = `# Title\n\n${paragraphs.join('\n\n')}\n`;
    const doc = chunkDocument(md, { maxChars: 600, overlap: 100, fallbackRef: 'notes.md' });
    expect(doc.meta.ref).toBe('notes.md');
    expect(doc.meta.product).toBe('unknown');
    const body = doc.chunks.slice(1);
    expect(body.length).toBeGreaterThan(2);
    for (const c of body) expect(c.text.length).toBeLessThanOrEqual(600);
    // Each piece after the first starts with the tail of the previous one.
    for (let i = 2; i < body.length; i++) {
      const prev = body[i - 1]?.text ?? '';
      const tail = prev.slice(-40);
      expect(body[i]?.text.includes(tail.trim().slice(0, 20))).toBe(true);
    }
    expect(body.every((c) => c.heading === 'Title')).toBe(true);
    const joined = body.map((c) => c.text).join('');
    for (const p of paragraphs) expect(joined).toContain(p.slice(0, 40));
  });

  it('hard-splits a single paragraph longer than the limit and keeps fences whole when they fit', () => {
    const doc = chunkDocument(
      `# H\n\n${'x'.repeat(1200)}\n\n\`\`\`js\n${'y\n'.repeat(20)}\`\`\`\n`,
      {
        maxChars: 500,
        overlap: 20,
      }
    );
    const body = doc.chunks.slice(1);
    expect(body.length).toBeGreaterThanOrEqual(3);
    const fence = `\`\`\`js\n${'y\n'.repeat(20)}\`\`\``;
    expect(body.some((c) => c.text.includes(fence))).toBe(true);
  });

  it('derives the product from the frontmatter shape when lassi.product is absent', () => {
    expect(docMetaFromFrontmatter({ key: 'PROJ-1', summary: 'S' })).toEqual({
      product: 'jira',
      ref: 'PROJ-1',
      title: 'S',
    });
    expect(docMetaFromFrontmatter({ id: 7, title: 'P' })).toEqual({
      product: 'confluence',
      ref: '7',
      title: 'P',
    });
    expect(docMetaFromFrontmatter(undefined, 'x.md')).toEqual({
      product: 'unknown',
      ref: 'x.md',
      title: 'x.md',
    });
  });
});

describe('headings that are not plain ATX', () => {
  const opts = { maxChars: 1500, overlap: 200, fallbackRef: 'n.md' };

  it('reads a setext heading without its underline', () => {
    const doc = chunkDocument('Release notes\n=============\n\nBody text.\n', opts);
    // Slicing the source and stripping `#` left the underline in the heading, and that string was
    // stored, embedded and shown as the section a hit came from.
    expect(doc.chunks[1]?.heading).toBe('Release notes');
    // The section text is the source, underline and all, exactly as an ATX section keeps its `##`.
    expect(doc.chunks[1]?.embedText.split('\n')[0]).toBe('n.md — Release notes');
  });

  it('reads a closing-hash heading without its trailing hashes', () => {
    const doc = chunkDocument('## Steps ##\n\nBody text.\n', opts);
    expect(doc.chunks[1]?.heading).toBe('Steps');
  });

  it('keeps the inline text of a heading that carries markup', () => {
    const doc = chunkDocument('## The `login` **page**\n\nBody text.\n', opts);
    expect(doc.chunks[1]?.heading).toBe('The login page');
  });
});

describe('chunk offsets', () => {
  it('address the chunk text even when the overlap is larger than half the cut', () => {
    const body = `# T\n\n${'x'.repeat(900)}\n\n${'y'.repeat(2000)}\n`;
    const doc = chunkDocument(body, { maxChars: 1500, overlap: 1000, fallbackRef: 'n.md' });
    // The splitter and the caller used to advance by different amounts, so start/end drifted off
    // the text they were meant to address as soon as the overlap passed half the cut.
    for (const chunk of doc.chunks.slice(1)) {
      expect(body.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  it('refuses a non-positive maxChars instead of allocating for ever', () => {
    expect(() =>
      chunkDocument('# T\n\nbody\n', { maxChars: 0, overlap: 0, fallbackRef: 'n.md' })
    ).toThrow(/maxChars must be a positive integer/);
  });
});
