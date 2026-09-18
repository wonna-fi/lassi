import { storageToMdast, type PageShapes } from './storage-to-mdast.js';

/**
 * Editor-form choices the storage format leaves open. `page update` infers them
 * from the cached original so an edited page keeps its shell; `page create` uses the defaults.
 */
export interface StorageWriterOptions {
  tableShell: 'plain' | 'wrapped' | 'wrapped-colgroup';
  cellWrap: 'none' | 'p';
  mentionAttribute: 'userkey' | 'username';
  /** Whether a task body carries the editor's placeholder span. */
  taskBody: 'span' | 'bare';
  /** Whether a URL that is its own label is written as an anchor or as plain text. */
  autolink: 'anchor' | 'text';
}

export const DEFAULT_WRITER_OPTIONS: StorageWriterOptions = {
  tableShell: 'plain',
  cellWrap: 'none',
  mentionAttribute: 'userkey',
  taskBody: 'span',
  autolink: 'text',
};

function majority<T extends string>(seen: readonly T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const value of seen) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = fallback;
  // Seeded with the fallback's own count so a tie really does keep it; starting at zero handed the
  // vote to whichever value the reader happened to see first.
  let bestCount = counts.get(fallback) ?? 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Majority vote per aspect over the shapes the reader saw; aspects never seen keep the defaults. */
export function inferWriterOptions(
  shapes: PageShapes,
  defaults: StorageWriterOptions = DEFAULT_WRITER_OPTIONS
): StorageWriterOptions {
  return {
    tableShell: majority(shapes.tableShells, defaults.tableShell),
    cellWrap: majority(shapes.cellWraps, defaults.cellWrap),
    mentionAttribute: majority(shapes.mentionAttributes, defaults.mentionAttribute),
    taskBody: majority(shapes.taskBodies, defaults.taskBody),
    autolink: majority(shapes.autolinks, defaults.autolink),
  };
}

export function inferWriterOptionsFromStorage(storage: string): StorageWriterOptions {
  return inferWriterOptions(storageToMdast(storage).shapes);
}
