import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import { renderComments, wikiToMarkdown } from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { readBodyInput, type BodySource } from '../../input/body.js';
import { truncate } from '../../output/axi.js';
import { dryRunData } from '../../output/dry-run.js';
import { attach, type Session } from '../../run-command.js';
import { markdownBodyToWiki } from './body.js';
import { resolveIssueKey } from './issue-key.js';
import { group, jiraClient } from './shared.js';

const BODY_HELP = ['--body <md>', 'comment body as markdown'] as const;
const FILE_HELP = ['--file <path>', 'markdown file with the body ("-" reads stdin)'] as const;

export function registerComment(jira: Command, deps: CliDeps, session: Session): void {
  const comment = group(jira, 'comment', 'issue comments');

  const list = comment
    .command('list <KEY>')
    .description('comments as markdown (author, date, id, body)')
    .option('--limit <N>', 'newest N comments (default 50)');
  attach<[string], { limit?: string }>(list, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const limit = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new LassiError(
          'usage',
          `--limit must be a positive whole number, got "${opts.limit}"`
        );
      const client = await jiraClient(ctx);
      const page = await client.readComments(key, limit);
      const markdown =
        page.comments.length === 0
          ? `no comments on ${key}\n`
          : renderComments(page.comments, `# ${key} comments`);
      const note =
        page.incomplete || page.total > page.comments.length
          ? `(${page.comments.length} of ${page.total} comments shown${page.incomplete ? '; incomplete retrieval, retry or narrow the request' : ''})`
          : undefined;
      return {
        markdown,
        ...(note ? { trailer: note } : {}),
        data: { key, ...page },
        axi: {
          data: {
            key,
            total: page.total,
            shown: page.comments.length,
            incomplete: page.incomplete,
            complete: !page.incomplete && page.comments.length === page.total,
            comments: page.comments.map((c) => ({
              id: c.id,
              author: c.author?.name ?? null,
              created: c.created,
              body: truncate(wikiToMarkdown(c.body)),
            })),
          },
        },
      };
    },
  });

  const add = comment
    .command('add <KEY>')
    .description('add a comment written in markdown; prints the new comment id')
    .option(...BODY_HELP)
    .option(...FILE_HELP);
  attach<[string], BodySource>(add, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const markdown = (await readBodyInput(deps, opts, { required: true })) ?? '';
      const wiki = await markdownBodyToWiki(ctx, client, markdown);
      const preview = {
        method: 'POST' as const,
        path: `/rest/api/2/issue/${key}/comment`,
        payloadLabel: 'body (wiki markup)',
        payload: wiki,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const created = await client.addComment(key, wiki);
      return {
        markdown: `comment ${created.id} added to ${key}\n`,
        data: {
          key,
          id: created.id,
          url: `${client.browseUrl(key)}?focusedCommentId=${created.id}`,
        },
      };
    },
  });

  const edit = comment
    .command('edit <KEY> <ID>')
    .description('replace a comment body with markdown')
    .option(...BODY_HELP)
    .option(...FILE_HELP);
  attach<[string, string], BodySource>(edit, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, id], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const markdown = (await readBodyInput(deps, opts, { required: true })) ?? '';
      const wiki = await markdownBodyToWiki(ctx, client, markdown);
      const preview = {
        method: 'PUT' as const,
        path: `/rest/api/2/issue/${key}/comment/${encodeURIComponent(id)}`,
        payloadLabel: 'body (wiki markup)',
        payload: wiki,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const edited = await client.editComment(key, id, wiki);
      return { markdown: `comment ${edited.id} edited on ${key}\n`, data: { key, id: edited.id } };
    },
  });

  const del = comment
    .command('delete <KEY> <ID>')
    .description('delete one of your own comments (--any for other authors)')
    .option('--any', "delete other people's comments too");
  attach<[string, string], { any?: boolean }>(del, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, id], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const existing = await client.getComment(key, id);
      const author = existing.author?.name ?? 'an unknown user';
      if (!opts.any) {
        // own comments only unless --any; the author check is the blast-radius limit.
        const me = await client.myself();
        if (existing.author?.name !== me.name) {
          throw new LassiError(
            'validation',
            `comment ${id} on ${key} was written by ${author}, not by you (${me.name})`,
            {
              hint: "pass --any to delete other people's comments",
              context: { product: 'jira', issueKey: key },
            }
          );
        }
      }
      const preview = {
        method: 'DELETE' as const,
        path: `/rest/api/2/issue/${key}/comment/${encodeURIComponent(id)}`,
        payloadLabel: 'comment',
        payload: `${id} by ${author}, ${existing.created}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.deleteComment(key, id);
      return { markdown: `comment ${id} deleted from ${key}\n`, data: { key, id } };
    },
  });
}
