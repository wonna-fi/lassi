import type { JiraIssueTypeMeta } from '../client/types.js';

/** Config defaults and `--field` maps can never hijack these (mechanism from the reference client). */
export const STANDARD_FIELD_KEYS: ReadonlySet<string> = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
]);

export interface CreateIssueInput {
  project: string;
  issueType: string;
  summary: string;
  /** Wiki markup (already converted). */
  description?: string;
  /** Field id → API value, already coerced. */
  custom?: Record<string, unknown>;
}

export function buildCreateIssueFields(input: CreateIssueInput): Record<string, unknown> {
  const custom = Object.fromEntries(
    Object.entries(input.custom ?? {}).filter(([key]) => !STANDARD_FIELD_KEYS.has(key))
  );
  const fields: Record<string, unknown> = {
    ...custom,
    project: { key: input.project },
    issuetype: { name: input.issueType },
    summary: input.summary,
  };
  if (input.description !== undefined) fields['description'] = input.description;
  return fields;
}

/** Fields the server never auto-fills; everything else required must be present or defaulted. */
const AUTO_FILLED = new Set(['project', 'issuetype', 'reporter']);

/** Required field ids (per createmeta) that are neither set nor defaulted; the fail-fast pre-check. */
export function checkRequiredFields(
  typeMeta: JiraIssueTypeMeta,
  fields: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  for (const [id, meta] of Object.entries(typeMeta.fields)) {
    if (!meta.required || AUTO_FILLED.has(id)) continue;
    if (meta.hasDefaultValue) continue;
    const value = fields[id];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      missing.push(id);
    }
  }
  return missing;
}
