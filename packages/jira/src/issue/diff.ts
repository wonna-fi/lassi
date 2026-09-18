import { LassiError } from '@wonna/lassi-core';
import type { JiraFieldMetaMap, JiraFieldSchema } from '../client/types.js';
import { fieldIdFor } from '../fields/aliases.js';
import { AllowedValueMismatch, scalarToApiValue } from '../fields/normalize.js';
import type { IssueCache } from './cache.js';

export interface DiffInput {
  editable: Record<string, unknown>;
  readonly?: Record<string, unknown>;
  body: string;
}

export interface DiffResult {
  /** Field id → API value, ready for `PUT /issue/{key}` `fields`. */
  fields: Record<string, unknown>;
  changedKeys: string[];
  descriptionChanged: boolean;
  warnings: string[];
}

/** Schemas for the standard editable keys when neither editmeta nor the cache knows them. */
const STANDARD_SCHEMA: Record<string, JiraFieldSchema> = {
  summary: { type: 'string' },
  issuetype: { type: 'issuetype' },
  priority: { type: 'priority' },
  assignee: { type: 'user' },
  labels: { type: 'array', items: 'string' },
  components: { type: 'array', items: 'component' },
  fixVersions: { type: 'array', items: 'version' },
  versions: { type: 'array', items: 'version' },
  duedate: { type: 'date' },
  reporter: { type: 'user' },
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
  }
  return false;
}

function sameSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = new Set(a.map((v) => JSON.stringify(v)));
  return b.every((v) => sa.has(JSON.stringify(v)));
}

/**
 * Compares the edited frontmatter with the cache and turns changed keys into an API payload.
 * Deleted keys are ignored with a warning (an accidental deletion must not wipe a field: set the
 * key to `null` to clear it). `readonly` edits are warned about and ignored.
 */
export function frontmatterDiff(
  cache: IssueCache,
  current: DiffInput,
  aliases: Record<string, string>,
  editmeta?: JiraFieldMetaMap
): DiffResult {
  const fields: Record<string, unknown> = {};
  const changedKeys: string[] = [];
  const warnings: string[] = [];
  const merged = { ...cache.aliases, ...aliases };

  for (const [key, value] of Object.entries(current.editable)) {
    if (key === 'key') {
      if (value !== cache.key)
        warnings.push(
          `key cannot be changed (file says ${String(value)}, cache says ${cache.key}); ignored`
        );
      continue;
    }
    const before = cache.editable[key];
    const equal = key === 'labels' ? sameSet(before, value) : deepEqual(before, value);
    if (equal) continue;
    const id = fieldIdFor(merged, key);
    if (id === undefined) {
      throw new LassiError(
        'usage',
        `unknown field "${key}" in frontmatter; run \`lassi jira fields\` for the alias list`,
        {
          context: { product: 'jira', issueKey: cache.key, operation: 'update' },
        }
      );
    }
    const meta = editmeta?.[id];
    const schema = meta?.schema ?? cache.fieldSchema[id] ?? STANDARD_SCHEMA[id];
    try {
      fields[id] = scalarToApiValue(value, schema, meta);
    } catch (err) {
      if (err instanceof AllowedValueMismatch) {
        throw new LassiError('validation', err.message, {
          errors: { [err.fieldId]: `Allowed: ${err.allowed.join(', ')}` },
          context: {
            product: 'jira',
            issueKey: cache.key,
            operation: 'update',
            allowedValues: { [err.fieldId]: err.allowed },
          },
        });
      }
      throw err;
    }
    changedKeys.push(key);
  }

  for (const key of Object.keys(cache.editable)) {
    if (!(key in current.editable)) {
      warnings.push(
        `"${key}" was removed from the file; not sent (set \`${key}: null\` to clear it)`
      );
    }
  }
  if (current.readonly) {
    for (const [key, value] of Object.entries(current.readonly)) {
      if (key in cache.readonly && !deepEqual(cache.readonly[key], value)) {
        warnings.push(`readonly.${key} was edited; ignored`);
      }
    }
  }

  const descriptionChanged =
    current.body.replace(/\s+$/, '') !== cache.descriptionMarkdown.replace(/\s+$/, '');
  return { fields, changedKeys, descriptionChanged, warnings };
}
