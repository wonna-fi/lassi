import { describe, expect, it } from 'vitest';
import { parsePageRef } from './refs.js';

describe('parsePageRef', () => {
  it.each([
    ['123456', undefined, { kind: 'id', id: '123456' }],
    ['DEV:Payment design', undefined, { kind: 'title', space: 'DEV', title: 'Payment design' }],
    ['~jsmith:Notes', undefined, { kind: 'title', space: '~jsmith', title: 'Notes' }],
    [
      'https://confluence.example.internal/pages/viewpage.action?pageId=123456',
      undefined,
      { kind: 'id', id: '123456' },
    ],
    [
      'https://confluence.example.internal/spaces/DEV/pages/123456/Design',
      undefined,
      { kind: 'id', id: '123456' },
    ],
    [
      'https://confluence.example.internal/display/DEV/Payment+design',
      undefined,
      { kind: 'title', space: 'DEV', title: 'Payment design' },
    ],
    [
      'https://confluence.example.internal/display/DEV/Release%3Anotes',
      undefined,
      { kind: 'title', space: 'DEV', title: 'Release:notes' },
    ],
    ['Payment design', 'DEV', { kind: 'title', space: 'DEV', title: 'Payment design' }],
  ])('%s → %o', (input, space, expected) => {
    expect(parsePageRef(input, space)).toEqual(expected);
  });

  it('rejects tiny links, unknown URLs and bare titles without a default space', () => {
    expect(() => parsePageRef('https://confluence.example.internal/x/AbCd')).toThrow(/tiny links/);
    expect(() => parsePageRef('https://confluence.example.internal/other')).toThrow(/page URL/);
    expect(() => parsePageRef('Payment design')).toThrow(/not a page reference/);
  });
});

describe('page URLs with characters decodeURIComponent rejects', () => {
  it('keeps a bare percent in a title instead of throwing', () => {
    expect(parsePageRef('https://confluence.example.internal/display/DEV/Rollout+100%')).toEqual({
      kind: 'title',
      space: 'DEV',
      title: 'Rollout 100%',
    });
    expect(parsePageRef('https://confluence.example.internal/display/DEV/50%+done')).toEqual({
      kind: 'title',
      space: 'DEV',
      title: '50% done',
    });
    // A properly encoded title still decodes.
    expect(parsePageRef('https://confluence.example.internal/display/DEV/Rollout+100%25')).toEqual({
      kind: 'title',
      space: 'DEV',
      title: 'Rollout 100%',
    });
  });
});
