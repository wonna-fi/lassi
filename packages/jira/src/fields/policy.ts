import { LassiError, type HintContext } from '@wonna/lassi-core';
import { aliasFor, CUSTOM_FIELD_ID, STANDARD_FIELD_NAMES } from './aliases.js';

/** `wiki`: Jira wiki markup shown as Markdown; `raw`: the value as Jira sends it. */
export type FieldFormat = 'raw' | 'wiki';

/** What one field's entries state; an unstated setting takes the field's default. */
export interface FieldSettings {
  editable?: boolean;
  format?: FieldFormat;
  exclude?: boolean;
}

/** One `jira.fields` value: a field id, or the id with its settings. */
export type FieldConfigEntry = string | ({ id: string } & FieldSettings);

export interface FieldPolicy {
  /** alias → field id, in config order. */
  aliases: Record<string, string>;
  /** field id → the settings its entries state. */
  settings: Record<string, FieldSettings>;
}

/** Frontmatter keys an alias would shadow, at the top level or under `readonly`. */
const BUILT_IN_KEYS: ReadonlySet<string> = new Set([
  'key',
  'summary',
  'type',
  'priority',
  'assignee',
  'labels',
  'components',
  'fixVersions',
  'description',
  'readonly',
  'counts',
  'lassi',
  'id',
  'status',
  'reporter',
  'created',
  'updated',
  'url',
  'resolution',
]);

/**
 * Fields behind the fixed frontmatter keys, the `readonly` facts and the body: they always appear
 * and write one way, so a setting on them could not take effect.
 */
const FIXED_FIELD_IDS: ReadonlySet<string> = new Set([
  'summary',
  'issuetype',
  'priority',
  'assignee',
  'labels',
  'components',
  'fixVersions',
  'description',
  'status',
  'reporter',
  'created',
  'updated',
  'resolution',
]);

const SETTING_NAMES = ['editable', 'format', 'exclude'] as const;

/** alias → field id, without validating anything, so error reporting can use it even when the policy is invalid. */
export function fieldAliases(entries: Record<string, FieldConfigEntry>): Record<string, string> {
  // Null-prototype records: an id like `__proto__` comes from untrusted workspace config and must
  // stay a plain key instead of reaching Object.prototype.
  const aliases: Record<string, string> = Object.create(null);
  for (const [alias, entry] of Object.entries(entries)) {
    aliases[alias] = typeof entry === 'string' ? entry : entry.id;
  }
  return aliases;
}

/**
 * Normalizes `jira.fields`. Settings belong to the field id, so two aliases of one field must not
 * disagree, and an alias must not shadow a frontmatter key or name a different field than it reads.
 */
export function fieldPolicy(entries: Record<string, FieldConfigEntry>): FieldPolicy {
  const aliases = fieldAliases(entries);
  const settings: Record<string, FieldSettings> = Object.create(null);
  const problems: string[] = [];
  for (const [alias, entry] of Object.entries(entries)) {
    const id = aliases[alias] as string;
    if (BUILT_IN_KEYS.has(alias)) {
      problems.push(`"${alias}" is a built-in frontmatter key; choose another alias for ${id}`);
    } else if ((CUSTOM_FIELD_ID.test(alias) || STANDARD_FIELD_NAMES.has(alias)) && alias !== id) {
      problems.push(`alias "${alias}" is itself a field id but maps to ${id}`);
    }
    if (typeof entry === 'string') continue;
    const stated = SETTING_NAMES.filter((name) => entry[name] !== undefined);
    if (stated.length === 0) continue;
    if (FIXED_FIELD_IDS.has(id)) {
      problems.push(
        `${id} ("${alias}") is always shown as a built-in frontmatter key; remove ${stated.join(', ')}`
      );
      continue;
    }
    const merged: FieldSettings = settings[id] ?? {};
    for (const name of stated) {
      const value = entry[name];
      if (merged[name] !== undefined && merged[name] !== value) {
        problems.push(`two entries for ${id} disagree on ${name}`);
      } else {
        (merged as Record<string, unknown>)[name] = value;
      }
    }
    settings[id] = merged;
  }
  if (problems.length > 0) {
    throw new LassiError('usage', `invalid jira.fields: ${problems.join('; ')}`, {
      hint: 'fix those entries; `lassi config show` names the file each one comes from',
      context: { product: 'jira' },
    });
  }
  return { aliases, settings };
}

/** Custom fields are read-only unless an entry makes them editable; other fields the other way round. */
export function isWritable(policy: FieldPolicy, id: string): boolean {
  return policy.settings[id]?.editable ?? !CUSTOM_FIELD_ID.test(id);
}

export function isExcluded(policy: FieldPolicy, id: string): boolean {
  return policy.settings[id]?.exclude === true;
}

export function formatOf(policy: FieldPolicy, id: string): FieldFormat {
  return policy.settings[id]?.format ?? 'raw';
}

/** Refuses, in one error, every field the policy does not let Lassi write. */
export function assertWritable(
  policy: FieldPolicy,
  fields: ReadonlyArray<{ key: string; id: string }>,
  context: HintContext
): void {
  const refused = fields.filter((f) => !isWritable(policy, f.id));
  if (refused.length === 0) return;
  const label = (f: { key: string; id: string }) => (f.key === f.id ? f.id : `${f.key} (${f.id})`);
  const fixes = refused.map(({ id }) => {
    const alias = aliasFor(policy.aliases, id);
    // Not the alias aliasFor finds: another alias of the same field may be the one that says so.
    if (policy.settings[id]?.editable === false) {
      return CUSTOM_FIELD_ID.test(id)
        ? `set "editable": true on every jira.fields entry for ${id}`
        : `remove "editable": false from the jira.fields entry for ${id}`;
    }
    return alias === undefined
      ? `add { "id": "${id}", "editable": true } under jira.fields`
      : `set "editable": true on jira.fields.${alias}`;
  });
  throw new LassiError(
    'usage',
    `read-only field${refused.length === 1 ? '' : 's'}: ${refused.map(label).join(', ')}`,
    {
      errors: Object.fromEntries(refused.map((f) => [f.id, 'read-only in jira.fields'])),
      hint: `${fixes.join('; ')} to let Lassi write ${refused.length === 1 ? 'it' : 'them'}, if Jira allows it (\`lassi jira fields\` lists the policy)`,
      context: { ...context, aliases: policy.aliases },
    }
  );
}
