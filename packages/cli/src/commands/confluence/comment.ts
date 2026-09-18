import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { readBodyInput, type BodySource } from '../../input/body.js';
import { truncate } from '../../output/axi.js';
import { dryRunData } from '../../output/dry-run.js';
import { attach, type Session } from '../../run-command.js';
import { markdownBodyToStorage } from './body.js';
import { confluenceClient, converterFor, group } from './shared.js';

export function registerComment(confluence: Command, deps: CliDeps, session: Session): Command {
  const comment = group(confluence, 'comment', 'footer comments');
  const list = comment
    .command('list <PAGE_ID>')
    .description('footer comments as markdown (author, date, id, body)');
  attach<[string], Record<string, never>>(list, deps, session, {
    kind: 'read',
    async run(ctx, [pageId]) {
      const client = await confluenceClient(ctx);
      const listed = await client.listComments(pageId);
      if (listed.truncated)
        ctx.logger.warn(
          `page ${pageId} has more comments than one walk returns (1000); only the first are listed`
        );
      const comments = listed.items;
      if (comments.length === 0) {
        return {
          markdown: `no comments on page ${pageId}\n`,
          data: [],
          axi: { data: { pageId, total: 0, comments: [] } },
        };
      }
      const converter = await converterFor(
        ctx,
        client,
        comments.map((c) => c.storage)
      );
      const parts = comments.map(
        (c) =>
          `### ${c.author?.username ?? 'unknown'} · ${c.created ?? ''} · id ${c.id}\n\n${converter.toMarkdown(c.storage).trimEnd()}\n`
      );
      return {
        markdown: parts.join('\n'),
        data: comments,
        axi: {
          data: {
            pageId,
            total: comments.length,
            comments: comments.map((c) => ({
              id: c.id,
              author: c.author?.username ?? null,
              created: c.created ?? null,
              body: truncate(converter.toMarkdown(c.storage)),
            })),
          },
        },
      };
    },
  });

  const add = comment
    .command('add <PAGE_ID>')
    .description('add a footer comment written in markdown; prints the new comment id')
    .option('--body <md>', 'comment body as markdown')
    .option('--file <path>', 'markdown file with the body ("-" reads stdin)');
  attach<[string], BodySource>(add, deps, session, {
    kind: 'write',
    async run(ctx, [pageId], opts) {
      const client = await confluenceClient(ctx);
      const markdown = (await readBodyInput(deps, opts, { required: true })) ?? '';
      const { storage } = await markdownBodyToStorage(ctx, client, markdown);
      const preview = {
        method: 'POST' as const,
        path: '/rest/api/content',
        payloadLabel: 'body (storage)',
        payload: storage,
        note: `footer comment on page ${pageId}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const created = await client.createComment(pageId, storage);
      return {
        markdown: `comment ${created.id} added to page ${pageId}\n`,
        data: {
          pageId,
          id: created.id,
          url: `${client.pageUrl(pageId)}&focusedCommentId=${created.id}`,
        },
      };
    },
  });

  const del = comment
    .command('delete <COMMENT_ID>')
    .description('delete one of your own comments (--any for other authors)')
    .option('--any', "delete other people's comments too");
  attach<[string], { any?: boolean }>(del, deps, session, {
    kind: 'write',
    async run(ctx, [id], opts) {
      const client = await confluenceClient(ctx);
      const existing = await client.getComment(id);
      // `DELETE /rest/api/content/{id}` removes pages just as happily; only comments pass here.
      if (existing.type !== 'comment') {
        throw new LassiError(
          'usage',
          `${id} is a ${existing.type ?? 'content item'}, not a comment`,
          {
            context: { product: 'confluence' },
          }
        );
      }
      const author = existing.history?.createdBy?.username ?? 'an unknown user';
      if (!opts.any) {
        // own comments only unless --any; the author check is the blast-radius limit.
        const me = await client.currentUser();
        if (existing.history?.createdBy?.username !== me.username) {
          throw new LassiError(
            'validation',
            `comment ${id} was written by ${author}, not by you (${me.username ?? 'unknown'})`,
            {
              hint: "pass --any to delete other people's comments",
              context: { product: 'confluence' },
            }
          );
        }
      }
      const preview = {
        method: 'DELETE' as const,
        path: `/rest/api/content/${encodeURIComponent(id)}`,
        payloadLabel: 'comment',
        payload: `${id} by ${author}, ${existing.history?.createdDate ?? ''}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.deleteComment(id);
      return { markdown: `comment ${id} deleted\n`, data: { id } };
    },
  });
  return comment;
}
