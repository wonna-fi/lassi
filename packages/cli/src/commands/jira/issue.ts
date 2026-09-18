import type { Command } from 'commander';
import { LassiError, displayPath, parseSince, resolvePath } from '@wonna/lassi-core';
import { flattenChangelog, wikiToMarkdown, type JiraIssue } from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { truncate } from '../../output/axi.js';
import { renderEntity } from '../../output/entity.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import {
  aliasesOf,
  commentsOption,
  flattenFieldMeta,
  group,
  jiraClient,
  renderFieldMetaTable,
} from './shared.js';
import { registerIssueExport } from './export.js';
import { resolveIssueKey } from './issue-key.js';
import { registerIssueWrites } from './issue-write.js';
import {
  buildIssueDocument,
  loadIssueComments,
  commentCoverage,
  saveIssueWorkingFile,
  type Expansion,
  type IssueDocument,
} from './workfile.js';

/** The `--axi` view of an issue: editable keys, read-only facts and counts in one flat object. */
function issueSummary(doc: IssueDocument): Record<string, unknown> {
  const { readonly, counts, lassi: _lassi, ...rest } = doc.frontmatter;
  const editable = Object.fromEntries(
    Object.entries(rest).filter(([k]) => !/^customfield_\d+$/.test(k))
  );
  return { ...editable, ...readonly, counts };
}

function issueAxi(
  doc: IssueDocument,
  issue: JiraIssue,
  expansion: Expansion
): Record<string, unknown> {
  // A top-level key so a next step can name the resolved issue rather than the `.` the user typed.
  const out: Record<string, unknown> = {
    key: doc.frontmatter.key,
    issue: issueSummary(doc),
    description: doc.description,
  };
  const counts = doc.frontmatter.counts;
  let hidden = 0;
  if (expansion.comments === undefined) hidden += counts.comments;
  else {
    const all = issue.fields.comment?.comments ?? [];
    const shown = expansion.comments === 'all' ? all : all.slice(-expansion.comments);
    hidden += Math.max(0, counts.comments - shown.length);
    out['comments'] = shown.map((c) => ({
      id: c.id,
      author: c.author?.name ?? null,
      created: c.created,
      body: wikiToMarkdown(c.body).trimEnd(),
    }));
  }
  if (expansion.attachments) {
    out['attachments'] = (issue.fields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      mimeType: a.mimeType,
    }));
  } else hidden += counts.attachments;
  if (expansion.links) {
    out['links'] = (issue.fields.issuelinks ?? []).map((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return {
        id: l.id,
        type: l.type.name,
        direction: l.outwardIssue ? l.type.outward : l.type.inward,
        key: other?.key ?? null,
        summary: other?.fields?.summary ?? null,
        status: other?.fields?.status?.name ?? null,
      };
    });
  } else hidden += counts.links;
  out['hidden'] = hidden;
  out['commentCoverage'] = commentCoverage(issue, expansion.comments);
  return out;
}

interface GetOptions {
  out?: string;
  comments?: string | boolean;
  attachments?: boolean;
  links?: boolean;
  all?: boolean;
  fields?: string;
  json?: boolean;
}

interface SearchOptions {
  limit?: string;
  all?: boolean;
  fields?: string;
  out?: string;
  json?: boolean;
}

/** A changed value shown as one short line, like a comment body; `--json` keeps the whole thing. */
const CHANGELOG_VALUE_CHARS = 120;

function splitFields(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  // `--fields " "` names no field, which is no filter: as `[]` it matched nothing and printed
  // "no changes for  on KEY".
  return names.length > 0 ? names : undefined;
}

export function registerIssue(jira: Command, deps: CliDeps, session: Session): void {
  const issue = group(jira, 'issue', 'read, search, create and update issues');

  const get = issue
    .command('get <KEY>')
    .description(
      'issue as markdown with frontmatter; counts of comments, attachments and links are always shown (KEY may be "." for the current branch)'
    )
    .option('--out <file>', 'write the working file (and its cache) instead of printing')
    .option('--comments [N]', 'include comments (all, or the newest N)')
    .option('--attachments', 'include the attachment table')
    .option('--links', 'include the links table')
    .option('--all', 'include comments, attachments and links')
    .option('--fields <a,b>', 'limit the fields fetched (default: all)');
  attach<[string], GetOptions>(get, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg], opts) {
      // Before the client and the fetch: an unreachable Jira would otherwise mask the usage error,
      // and a reachable one would answer a request that was never going to be used.
      // Parsed first and then overridden, not skipped: `--all --comments 0.5` would otherwise
      // short-circuit past the check and fetch the issue with a count that is not one.
      const requested = commentsOption(opts.comments);
      const expansion: Expansion = {
        comments: opts.all ? 'all' : requested,
        attachments: Boolean(opts.attachments || opts.all),
        links: Boolean(opts.links || opts.all),
      };
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const fields = splitFields(opts.fields);
      const fetched = await loadIssueComments(
        client,
        await client.getIssue(
          key,
          fields ? { fields: [...new Set([...fields, 'comment', 'attachment', 'issuelinks'])] } : {}
        ),
        expansion.comments
      );
      const doc = buildIssueDocument(ctx, client, fetched, expansion);
      const trailer = doc.trailer ? { trailer: doc.trailer } : {};
      if (opts.out) {
        const saved = await saveIssueWorkingFile(ctx, fetched, doc, opts.out);
        return {
          markdown: `wrote ${opts.out} (cache: ${displayPath(deps.cwd, saved.cachePath)})\n`,
          ...trailer,
          data: {
            path: saved.outPath,
            cache: saved.cachePath,
            commentCoverage: commentCoverage(fetched, expansion.comments),
            frontmatter: doc.frontmatter,
            body: doc.body,
          },
          axi: {
            data: {
              path: displayPath(deps.cwd, saved.outPath),
              cache: displayPath(deps.cwd, saved.cachePath),
              key,
              summary: doc.frontmatter.summary,
              counts: doc.frontmatter.counts,
              commentCoverage: commentCoverage(fetched, expansion.comments),
            },
          },
        };
      }
      return {
        markdown: renderEntity(
          doc.frontmatter as unknown as Record<string, unknown>,
          doc.body,
          doc.fieldNames
        ),
        ...trailer,
        data: {
          frontmatter: doc.frontmatter,
          body: doc.body,
          issue: fetched,
          commentCoverage: commentCoverage(fetched, expansion.comments),
        },
        axi: { data: issueAxi(doc, fetched, expansion) },
      };
    },
  });

  const search = issue
    .command('search <JQL>')
    .description('search issues; table of key, summary, status, assignee, updated')
    .option('--limit <N>', 'page size (default 50)')
    .option('--all', 'walk every page (hard cap 5000)')
    .option('--fields <a,b>', 'extra fields to fetch (shown with --json)')
    .option('--out <file>', 'write the table to a file');
  attach<[string], SearchOptions>(search, deps, session, {
    kind: 'read',
    async run(ctx, [jql], opts) {
      const client = await jiraClient(ctx);
      const base = ['summary', 'status', 'assignee', 'updated'];
      const fields = [...new Set([...base, ...(splitFields(opts.fields) ?? [])])];
      const limit = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isFinite(limit) || limit <= 0)
        throw new LassiError('usage', `--limit must be a positive number, got "${opts.limit}"`);
      let issues: JiraIssue[];
      let total: number;
      if (opts.all) {
        const result = await client.searchAll({ jql, fields });
        issues = result.issues;
        total = result.total;
        if (result.truncated)
          ctx.logger.warn(`stopped at ${issues.length} of ${total} issues (hard cap)`);
      } else {
        const page = await client.search({ jql, fields, maxResults: limit });
        issues = page.issues;
        total = page.total;
        if (total > issues.length)
          ctx.logger.warn(`showing ${issues.length} of ${total} issues; use --limit or --all`);
      }
      const rows = issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary ?? '',
        status: i.fields.status?.name ?? '',
        assignee: i.fields.assignee?.name ?? '',
        updated: i.fields.updated ?? '',
      }));
      const table = renderTable(
        [
          { key: 'key', header: 'Key' },
          { key: 'summary', header: 'Summary' },
          { key: 'status', header: 'Status' },
          { key: 'assignee', header: 'Assignee' },
          { key: 'updated', header: 'Updated' },
        ],
        rows
      );
      const axi = { data: { total, shown: rows.length, issues: rows } };
      if (opts.out) {
        await deps.fs.writeFile(resolvePath(deps.cwd, opts.out), table);
        return {
          markdown: `wrote ${opts.out} (${issues.length} of ${total})\n`,
          data: { total, issues },
          axi: { data: { ...axi.data, path: opts.out } },
        };
      }
      return { markdown: table, data: { total, issues }, axi };
    },
  });

  const createmeta = issue
    .command('createmeta <PROJECT>')
    .description('issue types and their fields (required flags, allowed values, aliases)')
    .option('--type <T>', 'only this issue type');
  attach<[string], { type?: string }>(createmeta, deps, session, {
    kind: 'read',
    async run(ctx, [project], opts) {
      const client = await jiraClient(ctx);
      if (!opts.type) {
        ctx.logger.warn(
          `fetching field metadata for every issue type in ${project}; pass --type to narrow`
        );
      }
      const meta = await client.createmeta(project, opts.type);
      const aliases = aliasesOf(ctx);
      const parts = meta.issueTypes.map(
        (t) =>
          `## ${t.name}${t.subtask ? ' (subtask)' : ''}\n\n${renderFieldMetaTable(t.fields, aliases)}`
      );
      return {
        markdown: `# ${meta.project.key} createmeta (${meta.mode})\n\n${parts.join('\n')}`,
        data: meta,
        axi: {
          data: {
            project: meta.project.key,
            mode: meta.mode,
            issueTypes: meta.issueTypes.map((t) => t.name),
            fields: meta.issueTypes.flatMap((t) => flattenFieldMeta(t.name, t.fields, aliases)),
          },
        },
      };
    },
  });

  const editmeta = issue
    .command('editmeta <KEY>')
    .description('editable fields of an issue, with aliases');
  attach<[string], Record<string, never>>(editmeta, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg]) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const fields = await client.editmeta(key);
      return {
        markdown: `# ${key} editmeta\n\n${renderFieldMetaTable(fields, aliasesOf(ctx))}`,
        data: { key, fields },
        axi: { data: { key, fields: flattenFieldMeta('-', fields, aliasesOf(ctx)) } },
      };
    },
  });

  const changelog = issue
    .command('changelog <KEY>')
    .description('field changes over time: when, who, field, from, to; oldest first')
    .option(
      '--since <when>',
      'only changes after this: 30m, 2h, 1d, 1w, YYYY-MM-DD or an ISO 8601 date-time'
    )
    .option('--fields <a,b>', 'only these fields (alias, name or id)');
  attach<[string], { since?: string; fields?: string }>(changelog, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const since = opts.since === undefined ? undefined : parseSince(opts.since, deps.now());
      const wanted = splitFields(opts.fields);
      const log = await (await jiraClient(ctx)).changelog(key);
      if (log.truncated) {
        ctx.logger.warn(
          `Jira returned ${log.histories.length} of ${log.total} history entries for ${key}; the oldest are missing`
        );
      }
      // An 8 KB description edit is one row here; every other reader cuts a long value.
      const cut = (value: string): string => truncate(value, CHANGELOG_VALUE_CHARS);
      const rows = flattenChangelog(log.histories, {
        aliases: aliasesOf(ctx),
        ...(since ? { since: since.instant } : {}),
        ...(wanted ? { fields: wanted } : {}),
      });
      const scope = [since ? `since ${since.text}` : '', wanted ? `for ${wanted.join(', ')}` : '']
        .filter((s) => s.length > 0)
        .join(' ');
      const table =
        rows.length === 0
          ? `no changes${scope ? ` ${scope}` : ''} on ${key}\n`
          : renderTable(
              [
                { key: 'at', header: 'When' },
                { key: 'who', header: 'Who' },
                { key: 'field', header: 'Field' },
                { key: 'from', header: 'From' },
                { key: 'to', header: 'To' },
              ],
              rows.map((r) => ({ ...r, from: cut(r.from) || '-', to: cut(r.to) || '-' }))
            );
      const changes = rows.map(({ fieldId: _fieldId, ...row }) => row);
      const head = {
        key,
        summary: log.summary,
        status: log.status,
        total: log.total,
        shown: rows.length,
        truncated: log.truncated,
        ...(since ? { since: since.instant.toISOString() } : {}),
      };
      return {
        markdown: `# ${key} changelog\n\n${log.summary} (${log.status})\n\n${table}`,
        // --json keeps the whole value; it is the escape hatch for the full text.
        data: { ...head, changes },
        axi: {
          data: {
            ...head,
            changes: changes.map((row) => ({ ...row, from: cut(row.from), to: cut(row.to) })),
          },
        },
      };
    },
  });

  registerIssueWrites(issue, deps, session);
  registerIssueExport(issue, deps, session);
}
