import { parseAtlassianDate, type Since } from '@wonna/lassi-core';
import type { JiraChangeItem, JiraHistory } from '../client/types.js';
import { aliasFor } from '../fields/aliases.js';

export interface ChangeRow {
  /** Jira's timestamp verbatim, like every other date the CLI prints. */
  at: string;
  who: string;
  /** The alias when `fieldId` is aliased, otherwise Jira's display name. */
  field: string;
  fieldId?: string;
  from: string;
  to: string;
}

export interface FlattenOptions {
  /** Inclusive cut on the history's `created`. */
  since?: Date;
  /** Aliases, display names or ids; case-insensitive. */
  fields?: string[];
  aliases?: Record<string, string>;
}

export function matchesField(
  item: JiraChangeItem,
  wanted: string,
  aliases: Record<string, string> = {}
): boolean {
  const w = wanted.trim().toLowerCase();
  if (w === item.field.toLowerCase()) return true;
  if (item.fieldId !== undefined && w === item.fieldId.toLowerCase()) return true;
  const alias = Object.entries(aliases).find(([a]) => a.toLowerCase() === w);
  return alias !== undefined && alias[1] === item.fieldId;
}

/** A wire object's own property, so a prototype member never answers for a missing field. */
function own(item: JiraChangeItem, key: 'toString' | 'fromString'): string | null | undefined {
  return Object.hasOwn(item, key) ? item[key] : undefined;
}

/** One row per changed field, oldest first; the wire object never leaves this function. */
export function flattenChangelog(histories: JiraHistory[], opts: FlattenOptions = {}): ChangeRow[] {
  const aliases = opts.aliases ?? {};
  const ordered = histories
    .map((h, index) => ({
      h,
      index,
      // An unparseable `created` is kept, and sorts last: it is the one entry whose place in the
      // history is unknown. Switching the comparison key per pair instead made the comparator
      // non-transitive, and one such entry let TimSort emit an arbitrary permutation of the whole
      // history, so "oldest first" and the digest's chronology were simply wrong.
      at: parseAtlassianDate(h.created)?.getTime() ?? Number.POSITIVE_INFINITY,
    }))
    .filter(({ at }) => opts.since === undefined || at >= opts.since.getTime())
    // `Infinity - Infinity` is NaN, which is falsy, so two undated entries fall through to index.
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const rows: ChangeRow[] = [];
  for (const { h } of ordered) {
    const who = h.author?.name ?? h.author?.displayName ?? 'unknown';
    for (const item of h.items) {
      // `?.length`, not truthiness: an empty filter is no filter, and `[]` used to match nothing.
      if (opts.fields?.length && !opts.fields.some((f) => matchesField(item, f, aliases))) continue;
      rows.push({
        at: h.created,
        who,
        field:
          (item.fieldId === undefined ? undefined : aliasFor(aliases, item.fieldId)) ?? item.field,
        ...(item.fieldId === undefined ? {} : { fieldId: item.fieldId }),
        from: own(item, 'fromString') ?? item.from ?? '',
        // Not `item.toString`: an item without its own key answers with Object.prototype.toString,
        // which is a function, and `??` never sees undefined. The declared `string | null` on
        // JiraChangeItem hides that from the compiler.
        to: own(item, 'toString') ?? item.to ?? '',
      });
    }
  }
  return rows;
}

/**
 * JQL keeps a relative `--since` verbatim (`-1d`). An absolute one becomes a relative literal in
 * minutes, rounded up by one: Jira reads an unzoned date literal in the user's profile time zone,
 * which need not be the process's, while a relative literal only depends on Jira's clock. Either
 * way it is a prefilter; the exact cut is applied client-side against the instant.
 */
export function sinceToJql(since: Since, now: Date): string {
  if (since.relative) return `-${since.relative.amount}${since.relative.unit}`;
  const minutes = Math.max(1, Math.ceil((now.getTime() - since.instant.getTime()) / 60_000) + 1);
  return `-${minutes}m`;
}
