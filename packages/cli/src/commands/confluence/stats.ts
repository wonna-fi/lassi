import type { Command } from 'commander';
import { LassiError, quoteLiteral } from '@wonna/lassi-core';
import {
  observePage,
  summarize,
  type ConfluenceClient,
  type PageObservation,
  type StatsSummary,
  type TreeNode,
} from '@wonna/lassi-confluence';
import type { CliDeps } from '../../deps.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { confluenceClient, group } from './shared.js';

interface StatsOptions {
  space?: string;
  page?: string;
  depth?: string;
  limit?: string;
}

function positive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new LassiError('usage', `${flag} must be a positive number, got "${value}"`);
  return n;
}

function flatten(node: TreeNode, out: string[] = []): string[] {
  out.push(node.id);
  for (const child of node.children) flatten(child, out);
  return out;
}

async function collectSpace(
  client: ConfluenceClient,
  space: string,
  limit: number
): Promise<PageObservation[]> {
  const out: PageObservation[] = [];
  const cql = `space = ${quoteLiteral(space)} and type = page`;
  const iterator = client.searchIter(cql, { max: limit, expand: ['body.storage'] });
  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    out.push(observePage(step.value.id, step.value.body?.storage?.value ?? ''));
  }
  return out;
}

async function collectTree(
  client: ConfluenceClient,
  pageId: string,
  depth: number,
  limit: number
): Promise<PageObservation[]> {
  const { root } = await client.tree({ pageId }, { depth, maxNodes: limit });
  const out: PageObservation[] = [];
  for (const id of flatten(root).slice(0, limit)) {
    const content = await client.getContent(id, ['body.storage']);
    out.push(observePage(id, content.body?.storage?.value ?? ''));
  }
  return out;
}

export function renderStats(summary: StatsSummary, scope: string): string {
  const lines: string[] = [];
  lines.push(`# Confluence macros in ${scope} (${summary.pages} pages)`, '');
  lines.push(
    summary.macros.length === 0
      ? 'No macros found.\n'
      : renderTable(
          [
            { key: 'name', header: 'Macro' },
            { key: 'pages', header: 'Pages' },
            { key: 'occurrences', header: 'Occurrences' },
          ],
          summary.macros
        )
  );
  lines.push('## Conventions', '');
  lines.push(
    summary.conventions.length === 0
      ? 'Nothing observed.\n'
      : renderTable(
          [
            { key: 'aspect', header: 'Aspect' },
            { key: 'value', header: 'Value' },
            { key: 'pages', header: 'Pages' },
          ],
          summary.conventions
        )
  );
  lines.push(
    `## Raw-fence reasons (${summary.fencedPages} of ${summary.pages} pages need at least one fence)`,
    ''
  );
  lines.push(
    summary.fences.length === 0
      ? 'Every page converts without a raw fence.\n'
      : renderTable(
          [
            { key: 'name', header: 'Reason' },
            { key: 'pages', header: 'Pages' },
            { key: 'occurrences', header: 'Occurrences' },
          ],
          summary.fences
        )
  );
  return lines.join('\n');
}

/** `lassi confluence stats macros`: what a space uses, so the dialect grows where it matters. */
export function registerStats(confluence: Command, deps: CliDeps, session: Session): Command {
  const stats = group(confluence, 'stats', 'usage statistics over pages');
  const macros = stats
    .command('macros')
    .description(
      'macro histogram, editor conventions and raw-fence reasons for a space or a page tree'
    )
    .option('--space <KEY>', 'every page of the space (default: confluence.defaultSpace)')
    .option('--page <ID>', 'the page and its descendants instead of a space')
    .option('--depth <N>', 'tree depth with --page (default 3)')
    .option('--limit <N>', 'maximum pages to fetch (default 200)');
  attach<[], StatsOptions>(macros, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      if (opts.space !== undefined && opts.page !== undefined)
        throw new LassiError('usage', '--space and --page are mutually exclusive');
      const limit = positive(opts.limit, 200, '--limit');
      const depth = positive(opts.depth, 3, '--depth');
      const client = await confluenceClient(ctx);
      let observations: PageObservation[];
      let scope: string;
      if (opts.page !== undefined) {
        observations = await collectTree(client, opts.page, depth, limit);
        scope = `page ${opts.page} (depth ${depth})`;
      } else {
        const space = opts.space ?? ctx.config.confluence.defaultSpace;
        if (!space)
          throw new LassiError(
            'usage',
            'pass --space <KEY> or --page <ID>, or set confluence.defaultSpace'
          );
        observations = await collectSpace(client, space, limit);
        scope = `space ${space}`;
      }
      if (observations.length >= limit)
        ctx.logger.warn(`stopped at ${limit} pages; raise --limit to see more`);
      const summary = summarize(observations);
      return { markdown: renderStats(summary, scope), data: { scope, ...summary } };
    },
  });
  return stats;
}
