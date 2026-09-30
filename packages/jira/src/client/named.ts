import { LassiError } from '@wonna/lassi-core';

const LISTED = 20;

/**
 * The item called `name`: the exact spelling first, then the one case-insensitive match. Jira keeps
 * component and version names unique regardless of case, so two case-insensitive matches only
 * happen on odd data, and are refused rather than guessed.
 */
export function findByName<T extends { name: string }>(items: T[], name: string): T | undefined {
  const wanted = name.trim();
  const exact = items.find((i) => i.name === wanted);
  if (exact) return exact;
  const folded = items.filter((i) => i.name.toLowerCase() === wanted.toLowerCase());
  if (folded.length > 1) {
    throw new LassiError(
      'validation',
      `"${name}" matches ${folded.map((i) => `"${i.name}"`).join(', ')}`,
      { hint: 'use the exact spelling', context: { product: 'jira' } }
    );
  }
  return folded[0];
}

/** Names for an error message, cut after twenty so a large project still gives one readable line. */
export function nameList(items: Array<{ name: string }>): string {
  if (items.length === 0) return 'none';
  const shown = items.slice(0, LISTED).map((i) => i.name);
  const more = items.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, … (${more} more)` : ''}`;
}

export function quoted(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ');
}
