import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import { parsePageRef, type ConfluenceContent, type TreeNode } from '@wonna/lassi-confluence';
import type { CliDeps } from '../../deps.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { confluenceClient } from './shared.js';

interface SearchOptions {
  limit?: string;
  all?: boolean;
}

function updatedOf(c: ConfluenceContent): string {
  return c.history?.lastUpdated?.when ?? c.version?.when ?? '';
}

function renderTree(node: TreeNode, depth = 0): string {
  const line = `${'  '.repeat(depth)}- ${node.title} (${node.id})\n`;
  return line + node.children.map((c) => renderTree(c, depth + 1)).join('');
}

export function registerSearch(confluence: Command, deps: CliDeps, session: Session): void {
  const search = confluence
    .command('search <CQL>')
    .description('search content; table of id, type, space, title, updated')
    .option('--limit <N>', 'page size (default 50)')
    .option('--all', 'walk every page of results (hard cap 5000)');
  attach<[string], SearchOptions>(search, deps, session, {
    kind: 'read',
    async run(ctx, [cql], opts) {
      const limit = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isFinite(limit) || limit <= 0)
        throw new LassiError('usage', `--limit must be a positive number, got "${opts.limit}"`);
      const client = await confluenceClient(ctx);
      let results: ConfluenceContent[];
      let total: number | undefined;
      if (opts.all) {
        const all = await client.searchAll(cql, { pageSize: limit });
        results = all.results;
        total = all.total;
        if (all.truncated) ctx.logger.warn(`stopped at ${results.length} results (hard cap)`);
      } else {
        const page = await client.search(cql, { limit });
        results = page.results;
        total = page.totalSize;
        if (page.next)
          ctx.logger.warn(
            `showing ${results.length}${total === undefined ? '' : ` of ${total}`} results; use --limit or --all`
          );
      }
      const rows = results.map((r) => ({
        id: r.id,
        type: r.type,
        space: r.space?.key ?? '',
        title: r.title,
        updated: updatedOf(r),
      }));
      const table = renderTable(
        [
          { key: 'id', header: 'Id' },
          { key: 'type', header: 'Type' },
          { key: 'space', header: 'Space' },
          { key: 'title', header: 'Title' },
          { key: 'updated', header: 'Updated' },
        ],
        rows
      );
      return {
        markdown: rows.length === 0 ? `no results for ${cql}\n` : table,
        data: { total, results },
        axi: { data: { total: total ?? rows.length, shown: rows.length, pages: rows } },
      };
    },
  });

  const tree = confluence
    .command('tree <ID|SPACE>')
    .description('page hierarchy below a page, or below a space homepage')
    .option('--depth <N>', 'levels to descend (default 3)');
  attach<[string], { depth?: string }>(tree, deps, session, {
    kind: 'read',
    async run(ctx, [ref], opts) {
      const depth = opts.depth === undefined ? 3 : Number(opts.depth);
      if (!Number.isFinite(depth) || depth <= 0)
        throw new LassiError('usage', `--depth must be a positive number, got "${opts.depth}"`);
      const client = await confluenceClient(ctx);
      let root: { pageId: string } | { spaceKey: string };
      // A space key starts with a letter (or `~` for a personal space), so it can never be all
      // digits: the id case is the `else`.
      if (/^~?[A-Za-z][A-Za-z0-9_]*$/.test(ref)) root = { spaceKey: ref };
      else {
        const parsed = parsePageRef(ref, ctx.config.confluence.defaultSpace);
        root =
          parsed.kind === 'id'
            ? { pageId: parsed.id }
            : { pageId: (await client.findPageByTitle(parsed.space, parsed.title)).id };
      }
      const result = await client.tree(root, { depth });
      // Both, when both fired: raising maxNodes does nothing about a parent with too many
      // children, so hearing only about the node cap sends the reader to the wrong knob.
      if (result.truncated.includes('nodes')) ctx.logger.warn('tree truncated at 2000 nodes');
      if (result.truncated.includes('children'))
        ctx.logger.warn('tree truncated: a page has more children than one walk returns (1000)');
      return { markdown: renderTree(result.root), data: result };
    },
  });
}
