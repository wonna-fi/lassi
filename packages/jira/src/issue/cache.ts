import type { JiraFieldSchema, JiraIssue } from '../client/types.js';
import type { IssueFrontmatter } from './frontmatter.js';

/** What `issue update --file` diffs against; written by the CLI to `.lassi/cache/jira/<KEY>.json`. */
export interface IssueCache {
  schema: 1;
  key: string;
  fetchedAt: string;
  updated: string;
  /** Exactly the editable top-level keys as written to the working file. */
  editable: Record<string, unknown>;
  readonly: Record<string, unknown>;
  descriptionMarkdown: string;
  descriptionWiki: string | null;
  fieldSchema: Record<string, JiraFieldSchema>;
  aliases: Record<string, string>;
  /** Generated `## Comments` / `## Attachments` / `## Links` text appended to the body, if any. */
  sections?: string;
  /**
   * What each working file was written from, keyed by its path from the workspace root. One issue
   * can have several files at once (`issue get --out`, `issue export`, different `--comments`
   * choices); each must be diffed against its own fetch, or a later fetch of the same issue would
   * decide which trailing sections the earlier file is assumed to carry.
   */
  files?: Record<string, IssueFileState>;
}

/** One working file's fetch: the snapshot `issue update --file` diffs that file against. */
export interface IssueFileState {
  fetchedAt: string;
  updated: string;
  editable: Record<string, unknown>;
  readonly: Record<string, unknown>;
  descriptionMarkdown: string;
  sections: string;
}

/** The per-file snapshot of a freshly built cache, for the CLI to merge under its path. */
export function issueFileState(cache: IssueCache): IssueFileState {
  return {
    fetchedAt: cache.fetchedAt,
    updated: cache.updated,
    editable: cache.editable,
    readonly: cache.readonly,
    descriptionMarkdown: cache.descriptionMarkdown,
    sections: cache.sections ?? '',
  };
}

export function splitFrontmatterKeys(frontmatter: IssueFrontmatter): {
  editable: Record<string, unknown>;
  readonly: Record<string, unknown>;
} {
  const editable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'readonly' || key === 'counts' || key === 'lassi') continue;
    editable[key] = value;
  }
  return { editable, readonly: { ...frontmatter.readonly } };
}

export function buildIssueCache(
  issue: JiraIssue,
  frontmatter: IssueFrontmatter,
  descriptionMarkdown: string,
  fieldSchema: Record<string, JiraFieldSchema>,
  aliases: Record<string, string>,
  sections = ''
): IssueCache {
  const { editable, readonly } = splitFrontmatterKeys(frontmatter);
  return {
    schema: 1,
    key: issue.key,
    fetchedAt: frontmatter.lassi.fetchedAt,
    updated: issue.fields.updated ?? '',
    editable,
    readonly,
    descriptionMarkdown,
    descriptionWiki: issue.fields.description ?? null,
    fieldSchema,
    aliases,
    sections,
  };
}
