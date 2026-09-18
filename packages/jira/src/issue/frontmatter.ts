import type { JiraFieldSchema, JiraIssue } from '../client/types.js';
import { CUSTOM_FIELD_ID } from '../fields/aliases.js';
import { apiValueToScalar } from '../fields/normalize.js';

export interface IssueReadonly {
  id: string;
  status: string;
  reporter: string | null;
  created: string;
  updated: string;
  url: string;
  resolution?: string;
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
  /** Raw custom field id → display name (rendered as YAML comments). */
  comments: Record<string, string>;
  /** Field id → schema for every editable key, for the cache. */
  fieldSchema: Record<string, JiraFieldSchema>;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function issueToFrontmatter(
  issue: JiraIssue,
  aliases: Record<string, string>,
  opts: { baseUrl: string; fetchedAt: string }
): FrontmatterResult {
  const f = issue.fields;
  const schema = issue.schema ?? {};
  const comments: Record<string, string> = {};
  const fieldSchema: Record<string, JiraFieldSchema> = {};

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

  const aliasedIds = new Set<string>();
  for (const [alias, id] of Object.entries(aliases)) {
    aliasedIds.add(id);
    editable[alias] = apiValueToScalar(f[id], schema[id]);
    if (schema[id]) fieldSchema[id] = schema[id] as JiraFieldSchema;
  }
  for (const [id, value] of Object.entries(f)) {
    if (!CUSTOM_FIELD_ID.test(id) || aliasedIds.has(id) || isEmpty(value)) continue;
    editable[id] = apiValueToScalar(value, schema[id]);
    const name = issue.names?.[id];
    if (name) comments[id] = name;
    if (schema[id]) fieldSchema[id] = schema[id] as JiraFieldSchema;
  }

  const readonly: IssueReadonly = {
    id: issue.id,
    status: f.status?.name ?? '',
    reporter: f.reporter?.name ?? null,
    created: f.created ?? '',
    updated: f.updated ?? '',
    url: `${opts.baseUrl}/browse/${issue.key}`,
  };
  if (f.resolution?.name) readonly.resolution = f.resolution.name;

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
  return { frontmatter, comments, fieldSchema };
}
