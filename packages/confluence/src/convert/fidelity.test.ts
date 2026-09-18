import type { BodyConverter } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { checkFidelity, compareStorage } from './fidelity.js';

describe('compareStorage', () => {
  it('is equal for pretty-printed versus compact, editor bookkeeping and attribute order', () => {
    const a =
      '<p>Hello&nbsp;<strong>you</strong></p>\n<ac:structured-macro ac:macro-id="1" ac:name="toc" ac:schema-version="1"/>';
    const b =
      '<p>Hello&nbsp;<strong>you</strong></p><ac:structured-macro ac:name="toc"></ac:structured-macro>';
    expect(compareStorage(a, b)).toEqual({ equal: true, diffs: [], truncated: false });
  });

  it('reports changed text, missing and extra nodes and attribute changes with positional paths', () => {
    const a =
      '<p>one</p><p>two</p><table class="wrapped"><tbody><tr><td>x</td></tr></tbody></table>';
    const b = '<p>one</p><p>2</p><table><tbody><tr><td>x</td></tr></tbody></table><hr/>';
    const result = compareStorage(a, b);
    expect(result.equal).toBe(false);
    expect(result.diffs).toEqual([
      { path: '/p[2]/text()[1]', kind: 'changed', a: 'two', b: '2' },
      { path: '/table[1]/@class', kind: 'missing', a: 'wrapped' },
      { path: '/hr[1]', kind: 'extra', b: '<hr/>' },
    ]);
  });

  it('truncates after maxDiffs and truncates long values', () => {
    const a = Array.from({ length: 5 }, (_, i) => `<p>a${i}</p>`).join('');
    const b = Array.from({ length: 5 }, (_, i) => `<p>b${i}</p>`).join('');
    const result = compareStorage(a, b, { maxDiffs: 2 });
    expect(result.diffs).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.equal).toBe(false);
    const long = compareStorage('<p>x</p>', `<p>${'y'.repeat(200)}</p>`);
    expect(long.diffs[0]?.b).toHaveLength(121);
  });
});

describe('checkFidelity', () => {
  const identity: BodyConverter = {
    format: 'storage',
    toMarkdown: (raw) => `MD:${raw}`,
    fromMarkdown: (md) => md.slice(3),
  };
  const lossy: BodyConverter = {
    format: 'storage',
    toMarkdown: () => 'md',
    fromMarkdown: () => '<p>other</p>',
  };
  const throwing: BodyConverter = {
    format: 'storage',
    toMarkdown: () => 'md',
    fromMarkdown: () => {
      throw new Error('cannot write');
    },
  };

  it('accepts a converter that round-trips and refuses one that does not', () => {
    expect(checkFidelity('<p>a</p>', identity)).toMatchObject({
      equal: true,
      markdown: 'MD:<p>a</p>',
    });
    const refused = checkFidelity('<p>a</p>', lossy);
    expect(refused.equal).toBe(false);
    expect(refused.diffs[0]?.path).toBe('/p[1]/text()[1]');
  });

  it('reports a write failure without throwing', () => {
    expect(checkFidelity('<p>a</p>', throwing)).toMatchObject({
      equal: false,
      diffs: [],
      error: 'cannot write',
    });
  });
});
