import type { JiraFieldMeta, JiraFieldSchema } from '../client/types.js';

const NAMED_TYPES = new Set([
  'priority',
  'issuetype',
  'resolution',
  'status',
  'component',
  'version',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Jira API value → the scalar an agent sees in frontmatter. Users become usernames, options their
 * value, named things their name, projects their key. Unknown objects stay objects (YAML map).
 */
export function apiValueToScalar(value: unknown, schema?: JiraFieldSchema): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const items = schema?.items ? { type: schema.items } : undefined;
    return value.map((v) => apiValueToScalar(v, items));
  }
  if (!isRecord(value)) return value;
  if (
    schema?.type === 'user' ||
    (typeof value['name'] === 'string' && typeof value['displayName'] === 'string')
  ) {
    return value['name'];
  }
  if (typeof value['value'] === 'string') {
    if (isRecord(value['child']) && typeof value['child']['value'] === 'string') {
      return { value: value['value'], child: value['child']['value'] };
    }
    return value['value'];
  }
  if (schema?.type === 'project') return value['key'] ?? value['name'] ?? value;
  if (typeof value['key'] === 'string' && typeof value['name'] === 'string') return value['key'];
  if (typeof value['name'] === 'string') return value['name'];
  return value;
}

function matchAllowed(
  raw: string,
  meta: JiraFieldMeta | undefined
): { id?: string; value?: string; name?: string } | undefined {
  if (!meta?.allowedValues) return undefined;
  const wanted = raw.trim().toLowerCase();
  for (const allowed of meta.allowedValues) {
    const a = allowed as { id?: string; value?: string; name?: string; key?: string };
    if (
      a.value?.toLowerCase() === wanted ||
      a.name?.toLowerCase() === wanted ||
      a.id === raw ||
      a.key?.toLowerCase() === wanted
    ) {
      return a;
    }
  }
  return undefined;
}

export function allowedValueLabels(meta: JiraFieldMeta | undefined): string[] {
  return (meta?.allowedValues ?? [])
    .map(
      (a) =>
        (a as { value?: string; name?: string; key?: string }).value ??
        (a as { name?: string }).name ??
        (a as { key?: string }).key
    )
    .filter((v): v is string => typeof v === 'string');
}

export class AllowedValueMismatch extends Error {
  readonly fieldId: string;
  readonly allowed: string[];
  constructor(fieldId: string, raw: string, allowed: string[]) {
    super(`"${raw}" is not an allowed value for ${fieldId}`);
    this.name = 'AllowedValueMismatch';
    this.fieldId = fieldId;
    this.allowed = allowed;
  }
}

/**
 * Frontmatter / `--field` scalar → Jira API value, driven by the field schema. Objects are sent
 * verbatim (the JSON escape hatch for cascading selects and anything exotic).
 */
export function scalarToApiValue(
  value: unknown,
  schema: JiraFieldSchema | undefined,
  meta?: JiraFieldMeta
): unknown {
  if (value === null || value === undefined) return null;
  if (isRecord(value)) {
    if (typeof value['value'] === 'string' && typeof value['child'] === 'string') {
      return { value: value['value'], child: { value: value['child'] } };
    }
    return value;
  }
  const type = schema?.type;
  if (type === 'array') {
    const list = Array.isArray(value) ? value : [value];
    const itemSchema = schema?.items ? { type: schema.items } : undefined;
    return list.map((v) => scalarToApiValue(v, itemSchema, meta));
  }
  if (Array.isArray(value)) return value.map((v) => scalarToApiValue(v, schema, meta));
  const text = String(value);
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : Number(text);
    case 'option': {
      const match = matchAllowed(text, meta);
      if (meta?.allowedValues && !match) {
        throw new AllowedValueMismatch(meta.fieldId, text, allowedValueLabels(meta));
      }
      return { value: match?.value ?? text };
    }
    case 'user':
      return { name: text };
    case 'project':
      return { key: text };
    case 'component':
    case 'version': {
      const match = matchAllowed(text, meta);
      return match?.id ? { id: match.id } : { name: text };
    }
    default:
      if (type !== undefined && NAMED_TYPES.has(type)) {
        // Priority, resolution, issue type …: the screen's allowed values give the canonical name.
        const match = matchAllowed(text, meta);
        if (meta?.allowedValues && meta.allowedValues.length > 0 && !match) {
          throw new AllowedValueMismatch(meta.fieldId, text, allowedValueLabels(meta));
        }
        return { name: match?.name ?? text };
      }
      return value;
  }
}
