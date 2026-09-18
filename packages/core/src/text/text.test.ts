import { describe, expect, it } from 'vitest';
import { brief, escapeRegExp } from './brief.js';
import { quoteLiteral } from './quote.js';

describe('brief', () => {
  it('flattens whitespace and keeps the result within max, ellipsis included', () => {
    expect(brief('  one   two\nthree ', 40)).toBe('one two three');
    expect(brief('abcdefghij', 5)).toBe('abcd…');
    expect(brief('abcdefghij', 5)).toHaveLength(5);
  });

  it('never cuts a surrogate pair in half', () => {
    // '🙂' is two code units, so a naive slice could end on the high surrogate alone, which is not
    // a character and renders as a replacement glyph.
    const cut = brief(`ab🙂cd`, 4);
    expect(cut).toBe('ab…');
    expect([...cut]).toHaveLength(3);
  });
});

describe('escapeRegExp', () => {
  it('makes a metacharacter match itself', () => {
    expect(new RegExp(escapeRegExp('a.b(c)')).test('a.b(c)')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b(c)')).test('axbc')).toBe(false);
  });
});

describe('quoteLiteral', () => {
  it('escapes the backslash before the quote, so a trailing one cannot swallow the close', () => {
    expect(quoteLiteral('DEV')).toBe('"DEV"');
    expect(quoteLiteral('DEV\\')).toBe('"DEV\\\\"');
    expect(quoteLiteral('a"b')).toBe('"a\\"b"');
    expect(quoteLiteral('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('leaves a value that needs no escaping alone', () => {
    expect(quoteLiteral('jsmith')).toBe('"jsmith"');
  });
});
