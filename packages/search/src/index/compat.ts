import { LassiError } from '@wonna/lassi-core';
import type { IndexManifest } from './store.js';

export interface IndexMismatch {
  kind: 'model' | 'dimensions';
  /** What the index holds. */
  was: string | number;
  /** What the configuration, or the endpoint's answer, now offers. */
  now: string | number;
}

/**
 * The one rule behind every "these vectors cannot be mixed" refusal: a vector is comparable only
 * with vectors of the same model and the same width. Stated once so the library and the CLI cannot
 * drift apart on which changes are refused.
 */
export function indexMismatch(
  manifest: Pick<IndexManifest, 'model' | 'dimensions'>,
  want: { model?: string; dimensions?: number }
): IndexMismatch | undefined {
  if (want.model !== undefined && want.model !== manifest.model)
    return { kind: 'model', was: manifest.model, now: want.model };
  if (want.dimensions !== undefined && want.dimensions !== manifest.dimensions)
    return { kind: 'dimensions', was: manifest.dimensions, now: want.dimensions };
  return undefined;
}

const MISMATCH = Symbol.for('lassi.search.indexMismatch');

/**
 * Carries the mismatch on the error, so a CLI can add the flag that repairs it without having to
 * guess from the message and without touching the hint on any other failure.
 */
export function indexMismatchError(
  message: string,
  mismatch: IndexMismatch,
  hint: string
): LassiError {
  const err = new LassiError('validation', message, { hint });
  Object.defineProperty(err, MISMATCH, { value: mismatch, enumerable: false });
  return err;
}

export function indexMismatchOf(err: unknown): IndexMismatch | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as Record<symbol, IndexMismatch | undefined>)[MISMATCH];
}
