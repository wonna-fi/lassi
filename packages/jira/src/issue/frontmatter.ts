import type { JiraFieldSchema, JiraIssue } from '../client/types.js';
import { CUSTOM_FIELD_ID } from '../fields/aliases.js';
import { apiValueToScalar } from '../fields/normalize.js';
import { formatOf, isExcluded, isWritable, type FieldPolicy } from '../fields/policy.js';
import { wikiToMarkdown } from '../wiki/index.js';

export interface IssueReadonly {
  id: string;
  status: string;
  reporter: string | null;
  created: string;
  updated: string;
  url: string;
  resolution?: string;
  /** Read-only fields: aliases under their alias, the rest under their raw id. */
  [field: string]: unknown;
}

export interface IssueCounts {
  comments: number;
  attachments: number;
  links: number;
}

/** top-level keys are editable; `readonly`, `counts` and `lassi` are informational. */
export interface IssueFrontmatter {
  key: string;
  summary: string;
  type: string;
  priority: string | null;
  assignee: string | null;
  labels: string[];
  components?: string[];
  fixVersions?: string[];
  [customAliasOrId: string]: unknown;
  readonly: IssueReadonly;
  counts: IssueCounts;
  lassi: { fetchedAt: string; product: 'jira'; schema: 1 };
}

export interface FrontmatterResult {
  frontmatter: IssueFrontmatter;
  /** `readonly.<raw custom field id>` → display name (rendered as YAML comments). */
  comments: Record<string, string>;
  /** Field id → schema for every aliased or custom key, for the cache. */
  fieldSchema: Record<string, JiraFieldSchema>;
  /** Field id → `wiki` for each value shown as Markdown, so update converts it back. */
  formats: Record<string, 'wiki'>;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Splits an issue into editable keys and read-only facts. The configured policy decides where a
 * field goes: writable aliases are top-level keys, other aliases and unaliased custom fields are
 * under `readonly`, and excluded fields are left out so a value that changes on every read does not
 * change the file.
 */
export function issueToFrontmatter(
  issue: JiraIssue,
  policy: FieldPolicy,
  opts: { baseUrl: string; fetchedAt: string }
): FrontmatterResult {
  const f = issue.fields;
  const schema = issue.schema ?? {};
  const comments: Record<string, string> = {};
  const fieldSchema: Record<string, JiraFieldSchema> = {};
  const formats: Record<string, 'wiki'> = {};

  const editable: Record<string, unknown> = {
    key: issue.key,
    summary: f.summary ?? '',
    type: f.issuetype?.name ?? '',
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.name ?? null,
    labels: f.labels ?? [],
  };
  if (f.components && f.components.length > 0)
    editable['components'] = f.components.map((c) => c.name);
  if (f.fixVersions && f.fixVersions.length > 0)
    editable['fixVersions'] = f.fixVersions.map((v) => v.name);

  const readonly: IssueReadonly = {
    id: issue.id,
    status: f.status?.name ?? '',
    reporter: f.reporter?.name ?? null,
    created: f.created ?? '',
    updated: f.updated ?? '',
    url: `${opts.baseUrl}/browse/${issue.key}`,
  };
  if (f.resolution?.name) readonly.resolution = f.resolution.name;

  const shown = (id: string): unknown => {
    const value = apiValueToScalar(f[id], schema[id]);
    if (formatOf(policy, id) !== 'wiki') return value;
    // Recorded even for an empty value: Markdown typed into it later must still go back as wiki.
    formats[id] = 'wiki';
    if (typeof value !== 'string') return value;
    // Trimmed so the YAML block scalar reads back as the same string.
    return wikiToMarkdown(value).replace(/\s+$/, '');
  };

  const aliasedIds = new Set<string>();
  for (const [alias, id] of Object.entries(policy.aliases)) {
    aliasedIds.add(id);
    if (isExcluded(policy, id)) continue;
    if (isWritable(policy, id)) editable[alias] = shown(id);
    else readonly[alias] = shown(id);
    if (schema[id]) fieldSchema[id] = schema[id] as JiraFieldSchema;
  }
  for (const [id, value] of Object.entries(f)) {
    if (!CUSTOM_FIELD_ID.test(id) || aliasedIds.has(id) || isEmpty(value)) continue;
    readonly[id] = shown(id);
    const name = issue.names?.[id];
    if (name) comments[`readonly.${id}`] = name;
    if (schema[id]) fieldSchema[id] = schema[id] as JiraFieldSchema;
  }

  const frontmatter = {
    ...editable,
    readonly,
    counts: {
      comments: f.comment?.total ?? f.comment?.comments?.length ?? 0,
      attachments: f.attachment?.length ?? 0,
      links: f.issuelinks?.length ?? 0,
    },
    lassi: { fetchedAt: opts.fetchedAt, product: 'jira' as const, schema: 1 as const },
  } as IssueFrontmatter;
  return { frontmatter, comments, fieldSchema, formats };
}
