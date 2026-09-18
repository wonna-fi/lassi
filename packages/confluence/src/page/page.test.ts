import { describe, expect, it } from 'vitest';
import type { ConfluencePage } from '../client/types.js';
import { pageTrailer, renderPageAttachments, renderPageComments } from './document.js';
import { diffEditableFields, pageToFrontmatter, storageSha256 } from './frontmatter.js';

const PAGE: ConfluencePage = {
  id: '123456',
  type: 'page',
  title: 'Payment service design',
  space: { key: 'DEV' },
  version: { number: 12, when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } },
  ancestors: [{ id: '100' }, { id: '123400' }],
  body: { storage: { value: '<p>Hello</p>', representation: 'storage' } },
  history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } } },
  counts: { children: 4, comments: 2, attachments: 5 },
};

describe('pageToFrontmatter', () => {
  it('produces the page frontmatter shape with the storage hash and format', () => {
    const fm = pageToFrontmatter(PAGE, {
      baseUrl: 'https://confluence.example.internal/',
      fetchedAt: '2026-09-04T10:00:00.000Z',
      format: 'md',
    });
    expect(fm).toEqual({
      id: 123456,
      title: 'Payment service design',
      space: 'DEV',
      parent: 123400,
      readonly: {
        version: 12,
        lastModified: '2026-09-01T12:00:00.000+0300',
        lastModifiedBy: 'jdoe',
        url: 'https://confluence.example.internal/pages/viewpage.action?pageId=123456',
      },
      counts: { children: 4, comments: 2, attachments: 5 },
      lassi: {
        fetchedAt: '2026-09-04T10:00:00.000Z',
        product: 'confluence',
        schema: 1,
        storageSha256: storageSha256('<p>Hello</p>'),
        format: 'md',
      },
    });
    expect(storageSha256('<p>Hello</p>')).toMatch(/^[0-9a-f]{64}$/);
    expect(
      pageToFrontmatter(
        { ...PAGE, ancestors: [] },
        { baseUrl: 'x', fetchedAt: 't', format: 'view' }
      ).parent
    ).toBeNull();
  });
});

describe('diffEditableFields', () => {
  it('detects title and parent changes, refuses space moves and unknown keys', () => {
    expect(
      diffEditableFields({ id: 123456, title: 'New', space: 'DEV', parent: 100 }, PAGE)
    ).toEqual({
      title: 'New',
      titleChanged: true,
      parentId: '100',
      parentChanged: true,
      spaceChanged: false,
      unknownKeys: [],
    });
    expect(
      diffEditableFields({ title: 'Payment service design', parent: 123400 }, PAGE)
    ).toMatchObject({
      titleChanged: false,
      parentChanged: false,
    });
    expect(diffEditableFields({ parent: null }, PAGE)).toMatchObject({
      parentId: null,
      parentChanged: true,
    });
    expect(diffEditableFields({ space: 'OTHER', bogus: 1 }, PAGE)).toMatchObject({
      spaceChanged: true,
      unknownKeys: ['bogus'],
    });
  });
});

describe('page sections', () => {
  it('renders comments, attachments and the trailer', () => {
    expect(
      renderPageComments(
        [{ id: '5', storage: '<p>hi</p>', author: { username: 'jsmith' }, created: '2026-09-02' }],
        (s) => s.replace(/<\/?p>/g, '')
      )
    ).toBe('## Comments\n\n### jsmith · 2026-09-02 · id 5\n\nhi\n');
    expect(
      renderPageAttachments([
        { id: '9', filename: 'a|b.png', mediaType: 'image/png', size: 2048, downloadPath: '/d' },
      ])
    ).toContain('| a\\|b.png | 2.0 KB | image/png | 9 |');
    expect(
      pageTrailer(
        { children: 0, comments: 2, attachments: 0 },
        { comments: false, attachments: false }
      )
    ).toBe('(2 comments not shown — use --comments)');
    expect(
      pageTrailer(
        { children: 1, comments: 0, attachments: 0 },
        { comments: true, attachments: true }
      )
    ).toBe('(1 child page not shown — use `lassi confluence tree <ID>`)');
    expect(
      pageTrailer(
        { children: 0, comments: 0, attachments: 0 },
        { comments: false, attachments: false }
      )
    ).toBeUndefined();
    // Only the capped kind is a floor: one flag for all three made an exact comment count read as
    // an estimate.
    expect(
      pageTrailer(
        { children: 1000, comments: 2, attachments: 0, truncated: ['children'] },
        { comments: false, attachments: false }
      )
    ).toBe(
      '(2 comments, 1000+ child pages not shown — use --comments, `lassi confluence tree <ID>`)'
    );
  });
});
