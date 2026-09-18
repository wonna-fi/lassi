import { isLassiError } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { indexMismatch, indexMismatchError, indexMismatchOf } from './compat.js';

const manifest = { model: 'text-embedding-3-small', dimensions: 1536 };

describe('indexMismatch', () => {
  it('refuses a different model or width and passes everything else', () => {
    expect(indexMismatch(manifest, { model: manifest.model, dimensions: 1536 })).toBeUndefined();
    expect(indexMismatch(manifest, {})).toBeUndefined();
    expect(indexMismatch(manifest, { model: 'text-embedding-3-large' })).toEqual({
      kind: 'model',
      was: 'text-embedding-3-small',
      now: 'text-embedding-3-large',
    });
    expect(indexMismatch(manifest, { model: manifest.model, dimensions: 256 })).toEqual({
      kind: 'dimensions',
      was: 1536,
      now: 256,
    });
  });

  // What lets a CLI add the flag that repairs it without guessing from the message.
  it('carries the mismatch on the error and nothing else does', () => {
    const mismatch = indexMismatch(manifest, { model: 'other' });
    if (!mismatch) throw new Error('expected a mismatch');
    const err = indexMismatchError('vectors cannot be mixed', mismatch, 'rebuild it');
    expect(isLassiError(err) && err.code).toBe('validation');
    expect(indexMismatchOf(err)).toEqual(mismatch);
    expect(JSON.stringify(err)).not.toContain('kind');
    for (const other of [new Error('boom'), undefined, null, 'string'])
      expect(indexMismatchOf(other)).toBeUndefined();
  });
});
