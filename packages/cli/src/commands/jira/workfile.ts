import { displayPath, resolvePath } from '@wonna/lassi-core';
import {
  buildIssueCache,
  composeBody,
  issueFileState,
  issueToFrontmatter,
  joinSections,
  normalizeLinks,
  renderAttachments,
  renderComments,
  renderLinks,
  trailerLine,
  wikiToMarkdown,
  type FrontmatterResult,
  type IssueCache,
  type IssueFrontmatter,
  type JiraClient,
  type JiraIssue,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import {
  lassiDirs,
  jiraCachePath,
  readJsonCache,
  writeJsonCache,
  writeWorkingFile,
} from '../../workfile/index.js';
import { aliasesOf } from './shared.js';

export interface Expansion {
  /** `undefined` = not shown; `'all'` or the newest N. */
  comments: number | 'all' | undefined;
  attachments: boolean;
  links: boolean;
}

export interface IssueDocument {
  frontmatter: IssueFrontmatter;
  /** Raw custom field id → display name, rendered as YAML comments. */
  fieldNames: Record<string, string>;
  fieldSchema: FrontmatterResult['fieldSchema'];
  description: string;
  sections: string[];
  body: string;
  trailer: string | undefined;
}

/** Frontmatter, description and the requested generated sections of one fetched issue. */
export function buildIssueDocument(
  ctx: Context,
  client: JiraClient,
  issue: JiraIssue,
  expansion: Expansion
): IssueDocument {
  const {
    frontmatter,
    comments: fieldNames,
    fieldSchema,
  } = issueToFrontmatter(issue, aliasesOf(ctx), {
    baseUrl: client.baseUrl,
    fetchedAt: ctx.deps.now().toISOString(),
  });
  const description = wikiToMarkdown(issue.fields.description ?? '');
  const sections: string[] = [];
  if (expansion.comments !== undefined) {
    const all = issue.fields.comment?.comments ?? [];
    sections.push(
      renderComments(expansion.comments === 'all' ? all : all.slice(-expansion.comments))
    );
    if (issue.fields.comment?.incomplete)
      sections.push(
        `${all.length === 0 ? '## Comments\n\n' : ''}> Incomplete comment retrieval; retry or narrow the request.`
      );
  }
  if (expansion.attachments) sections.push(renderAttachments(issue.fields.attachment ?? []));
  if (expansion.links)
    sections.push(renderLinks(issue.key, normalizeLinks(issue.fields.issuelinks)));
  const coverage = commentCoverage(issue, expansion.comments);
  return {
    frontmatter,
    fieldNames,
    fieldSchema,
    description,
    sections,
    body: composeBody(description, sections),
    trailer:
      [
        trailerLine(frontmatter.counts, {
          comments: expansion.comments !== undefined,
          attachments: expansion.attachments,
          links: expansion.links,
        }),
        expansion.comments !== undefined && !coverage.complete
          ? `(${coverage.shown} of ${coverage.total} comments shown${coverage.incomplete ? '; incomplete retrieval, retry or narrow the request' : ''})`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n') || undefined,
  };
}

/** Expanded issue fields are paginated snapshots; only a complete embedded page can satisfy a read. */
export async function loadIssueComments(
  client: JiraClient,
  issue: JiraIssue,
  requested: Expansion['comments']
): Promise<JiraIssue> {
  if (requested === undefined) return issue;
  const page = issue.fields.comment;
  if (page && !page.incomplete && page.startAt === 0 && page.comments.length === page.total)
    return issue;
  const comments = await client.readComments(issue.key, requested);
  return { ...issue, fields: { ...issue.fields, comment: comments } };
}

export function commentCoverage(issue: JiraIssue, requested: Expansion['comments']) {
  const page = issue.fields.comment;
  const total = page?.total ?? 0;
  const available = page?.comments.length ?? 0;
  const shown =
    requested === undefined ? 0 : requested === 'all' ? available : Math.min(requested, available);
  return {
    total,
    shown,
    requested: requested ?? null,
    complete: shown === total && !page?.incomplete,
    incomplete: page?.incomplete ?? false,
  };
}

/** Writes the working file and its cache; `outArg` is the path as the user gave it. */
export async function saveIssueWorkingFile(
  ctx: Context,
  issue: JiraIssue,
  doc: IssueDocument,
  outArg: string
): Promise<{ outPath: string; cachePath: string; sha256: string }> {
  const { deps } = ctx;
  const outPath = resolvePath(deps.cwd, outArg);
  const sha256 = await writeWorkingFile(
    outPath,
    { frontmatter: doc.frontmatter as unknown as Record<string, unknown>, body: doc.body },
    deps.fs,
    doc.fieldNames
  );
  const cachePath = jiraCachePath(
    lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir),
    issue.key
  );
  const previous = await readJsonCache<IssueCache>(cachePath, deps.fs);
  const cache = buildIssueCache(
    issue,
    doc.frontmatter,
    doc.description,
    doc.fieldSchema,
    aliasesOf(ctx),
    joinSections(doc.sections)
  );
  cache.files = { ...previous?.files, [displayPath(deps.cwd, outPath)]: issueFileState(cache) };
  await writeJsonCache(cachePath, cache, deps.fs);
  return { outPath, cachePath, sha256 };
}
