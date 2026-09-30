import { parseAtlassianDate, type Since } from '@wonna/lassi-core';
import type { JiraChangeItem, JiraFieldDef, JiraHistory } from '../client/types.js';
import { aliasFor, CUSTOM_FIELD_ID } from '../fields/aliases.js';

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
  /**
   * Field id → display name (`GET /field`), for items without `fieldId`: an alias or a
   * `customfield_N` filter can then only match the item's display name.
   */
  fieldNames?: Record<string, string>;
}

/**
 * System fields whose history name matches neither their id nor their edit-screen name: Jira
 * labels a components change "Component", and only Jira 8.3+ adds the `fieldId` that `components`
 * would match. Keyed by the history name, lower-cased; `names` are the other accepted spellings.
 */
const HISTORY_NAMES: Record<string, { id: string; names: readonly string[] }> = {
  component: { id: 'components', names: ['component/s'] },
  'fix version': { id: 'fixVersions', names: ['fix versions', 'fix version/s'] },
  version: { id: 'versions', names: ['affects versions', 'affects version/s'] },
  link: { id: 'issuelinks', names: [] },
};

/** Whether `w` names the system field behind this history name, when that is what the item is. */
function matchesHistoryName(item: JiraChangeItem, field: string, w: string): boolean {
  // Own keys only: a history name such as "constructor" must not reach Object.prototype.
  if (!Object.hasOwn(HISTORY_NAMES, field)) return false;
  const system = HISTORY_NAMES[field] as { id: string; names: readonly string[] };
  // A `fieldId` is authoritative: a custom field that happens to be called "Component" is not
  // the components field.
  if (item.fieldId !== undefined && item.fieldId !== system.id) return false;
  return w === system.id.toLowerCase() || system.names.includes(w);
}

/** The field id a filter names through an alias or as `customfield_N`, both in any case. */
export function changelogFilterFieldId(
  wanted: string,
  aliases: Record<string, string>
): string | undefined {
  const w = wanted.trim().toLowerCase();
  const alias = Object.entries(aliases).find(([a]) => a.toLowerCase() === w);
  if (alias !== undefined) return alias[1];
  return CUSTOM_FIELD_ID.test(w) ? w : undefined;
}

export function matchesField(
  item: JiraChangeItem,
  wanted: string,
  aliases: Record<string, string> = {},
  fieldNames: Record<string, string> = {}
): boolean {
  const w = wanted.trim().toLowerCase();
  const field = item.field.toLowerCase();
  if (w === field) return true;
  if (item.fieldId !== undefined && w === item.fieldId.toLowerCase()) return true;
  if (matchesHistoryName(item, field, w)) return true;
  const id = changelogFilterFieldId(wanted, aliases);
  if (id === undefined) return false;
  if (item.fieldId !== undefined) return item.fieldId === id;
  // Without a fieldId the display name is all the item has, so the id is compared through it:
  // the id itself for fields named by their id ("status"), the history name table, then the
  // instance's name for the field. Own keys only, like HISTORY_NAMES.
  if (id.toLowerCase() === field) return true;
  if (Object.hasOwn(HISTORY_NAMES, field) && HISTORY_NAMES[field]?.id === id) return true;
  const name = Object.hasOwn(fieldNames, id) ? fieldNames[id] : undefined;
  return name !== undefined && name.toLowerCase() === field;
}

/**
 * Whether filtering needs the instance's field names: some item came without `fieldId`, and some
 * filter names a custom field through an alias or its id, which only its display name can match.
 */
export function changelogNeedsFieldNames(
  histories: JiraHistory[],
  wanted: string[],
  aliases: Record<string, string>
): boolean {
  const custom = wanted.some((w) => {
    const id = changelogFilterFieldId(w, aliases);
    return id !== undefined && CUSTOM_FIELD_ID.test(id);
  });
  return custom && histories.some((h) => h.items.some((i) => i.fieldId === undefined));
}

/**
 * Field id → display name for `flattenChangelog`, and a warning for each custom field a filter
 * names that the instance lacks, or whose display name another field shares: without field ids,
 * changes to every field of that name match.
 */
export function changelogFieldNames(
  defs: JiraFieldDef[],
  wanted: string[],
  aliases: Record<string, string>
): { fieldNames: Record<string, string>; warnings: string[] } {
  // fromEntries defines own properties, so no id can reach the prototype.
  const fieldNames: Record<string, string> = Object.fromEntries(defs.map((d) => [d.id, d.name]));
  const warnings: string[] = [];
  for (const w of wanted) {
    const id = changelogFilterFieldId(w, aliases);
    if (id === undefined || !CUSTOM_FIELD_ID.test(id)) continue;
    const label = w.trim().toLowerCase() === id ? id : `${w.trim()} → ${id}`;
    const name = Object.hasOwn(fieldNames, id) ? fieldNames[id] : undefined;
    if (name === undefined) {
      warnings.push(`${label} is not a field on this instance`);
      continue;
    }
    const others = defs
      .filter((d) => d.id !== id && d.name.toLowerCase() === name.toLowerCase())
      .map((d) => d.id);
    if (others.length > 0) {
      warnings.push(
        `${label} is called "${name}", like ${others.join(', ')}; changes without a field id match all of them`
      );
    }
  }
  return { fieldNames, warnings };
}

/** A wire object's own property, so a prototype member never answers for a missing field. */
function own(item: JiraChangeItem, key: 'toString' | 'fromString'): string | null | undefined {
  return Object.hasOwn(item, key) ? item[key] : undefined;
}

/** One row per changed field, oldest first; the wire object never leaves this function. */
export function flattenChangelog(histories: JiraHistory[], opts: FlattenOptions = {}): ChangeRow[] {
  const aliases = opts.aliases ?? {};
  const fieldNames = opts.fieldNames ?? {};
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
      if (
        opts.fields?.length &&
        !opts.fields.some((f) => matchesField(item, f, aliases, fieldNames))
      )
        continue;
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
