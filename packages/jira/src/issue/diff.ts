import { LassiError } from '@wonna/lassi-core';
import type { JiraFieldMeta, JiraFieldMetaMap, JiraFieldSchema } from '../client/types.js';
import { fieldIdFor } from '../fields/aliases.js';
import { AllowedValueMismatch, scalarToApiValue, standardSchema } from '../fields/normalize.js';
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

/** One edited frontmatter key, before it is converted for the API. */
export interface FieldChange {
  /** The frontmatter key as written: an alias, a standard name or a raw id. */
  key: string;
  id: string;
  value: unknown;
  /** What the fetch recorded or the standard fields define; field metadata, when loaded, wins. */
  schema?: JiraFieldSchema;
}

export interface FrontmatterChanges {
  changes: FieldChange[];
  descriptionChanged: boolean;
  warnings: string[];
}

/**
 * Compares the edited frontmatter with the cache, without converting anything, so the caller can
 * tell from the changed fields whether their live metadata is needed at all. Deleted keys are
 * ignored with a warning (an accidental deletion must not wipe a field: set the key to `null` to
 * clear it). `readonly` edits are warned about and ignored.
 */
export function frontmatterChanges(
  cache: IssueCache,
  current: DiffInput,
  aliases: Record<string, string>
): FrontmatterChanges {
  const changes: FieldChange[] = [];
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
    const schema = cache.fieldSchema[id] ?? standardSchema(id);
    changes.push({ key, id, value, ...(schema ? { schema } : {}) });
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
  return { changes, descriptionChanged, warnings };
}

/** One change as its API value; a value outside the field's allowed values is a validation error. */
export function fieldChangeToApi(
  change: FieldChange,
  issueKey: string,
  meta?: JiraFieldMeta
): unknown {
  try {
    return scalarToApiValue(change.value, meta?.schema ?? change.schema, meta);
  } catch (err) {
    if (err instanceof AllowedValueMismatch) {
      throw new LassiError('validation', err.message, {
        errors: { [err.fieldId]: `Allowed: ${err.allowed.join(', ')}` },
        context: {
          product: 'jira',
          issueKey,
          operation: 'update',
          allowedValues: { [err.fieldId]: err.allowed },
        },
      });
    }
    throw err;
  }
}

/** `frontmatterChanges` and `fieldChangeToApi` in one step, for a caller that already has the metadata. */
export function frontmatterDiff(
  cache: IssueCache,
  current: DiffInput,
  aliases: Record<string, string>,
  editmeta?: JiraFieldMetaMap
): DiffResult {
  const { changes, descriptionChanged, warnings } = frontmatterChanges(cache, current, aliases);
  const fields: Record<string, unknown> = {};
  for (const change of changes) {
    fields[change.id] = fieldChangeToApi(change, cache.key, editmeta?.[change.id]);
  }
  return { fields, changedKeys: changes.map((c) => c.key), descriptionChanged, warnings };
}
