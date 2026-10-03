import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import {
  findLinks,
  issueLinkRequest,
  resolveLinkDirection,
  type JiraIssueLink,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { resolveIssueKey } from './issue-key.js';
import { group, jiraClient } from './shared.js';

export function registerIssueLinks(issue: Command, deps: CliDeps, session: Session): void {
  const link = group(issue, 'link', 'links between issues');
  const list = link.command('list <KEY>').description('links on an issue, with direction');
  attach<[string], Record<string, never>>(list, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg]) {
      const key = await resolveIssueKey(ctx, keyArg);
      const links = await (await jiraClient(ctx)).listLinks(key);
      const table = renderTable(
        [
          { key: 'link', header: 'Link' },
          { key: 'otherKey', header: 'Key' },
          { key: 'otherSummary', header: 'Summary' },
          { key: 'otherStatus', header: 'Status' },
        ],
        links.map((l) => ({ ...l, link: `${key} ${l.description} ${l.otherKey}` }))
      );
      return {
        markdown: links.length === 0 ? `no links on ${key}\n` : table,
        data: { key, links },
      };
    },
  });

  const create = link
    .command('create <KEY1> <KEY2>')
    .description(
      'link two issues; --type is the outward phrase ("blocks"), the type name, or the inward phrase ("is blocked by", direction flipped)'
    )
    .requiredOption('--type <NAME>', 'link type name or direction phrase');
  attach<[string, string], { type: string }>(create, deps, session, {
    kind: 'write',
    async run(ctx, [fromArg, toArg], opts) {
      const from = await resolveIssueKey(ctx, fromArg);
      const to = await resolveIssueKey(ctx, toArg);
      if (from === to) throw new LassiError('usage', `cannot link ${from} to itself`);
      const client = await jiraClient(ctx);
      const resolved = resolveLinkDirection(await client.getLinkTypes(), opts.type, from, to);
      // The same body createLink sends, so the preview shows Jira's field names as they go out.
      const body = issueLinkRequest(resolved.type.name, resolved.sourceKey, resolved.targetKey);
      // The dry run prints the resolved sentence, the common direction mistake made visible.
      const preview = {
        method: 'POST' as const,
        path: '/rest/api/2/issueLink',
        payloadLabel: 'link (json)',
        payload: JSON.stringify(body, null, 2),
        note: resolved.sentence,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.createLink({
        typeName: resolved.type.name,
        sourceKey: resolved.sourceKey,
        targetKey: resolved.targetKey,
      });
      return { markdown: `${resolved.sentence}\n`, data: { ...body, sentence: resolved.sentence } };
    },
  });

  const remove = link
    .command('delete <KEY1> <KEY2>')
    .description(
      'delete the link that `link list KEY1` shows as KEY1 <phrase> KEY2; --type takes the same phrases as create'
    )
    .requiredOption('--type <NAME>', 'link type name or direction phrase');
  attach<[string, string], { type: string }>(remove, deps, session, {
    kind: 'write',
    async run(ctx, [fromArg, toArg], opts) {
      const from = await resolveIssueKey(ctx, fromArg);
      const to = await resolveIssueKey(ctx, toArg);
      if (from === to) throw new LassiError('usage', `${from} cannot be linked to itself`);
      const client = await jiraClient(ctx);
      const resolved = resolveLinkDirection(await client.getLinkTypes(), opts.type, from, to);
      const links = await client.listLinks(from);
      const matches = findLinks(links, resolved, from);
      const context = { product: 'jira' as const, issueKey: from, operation: 'link' as const };
      if (matches.length === 0) {
        // A link created the other way round is the usual reason: name the ones that do exist.
        const between = links
          .filter((l) => l.otherKey === to)
          .map((l) => `${from} ${l.description} ${to}`);
        throw new LassiError('not_found', `no link ${resolved.sentence}`, {
          hint:
            between.length > 0
              ? `${from} and ${to} are linked as: ${between.join('; ')}; pass that phrase to --type`
              : `run \`lassi jira issue link list ${from}\` to see its links`,
          context,
        });
      }
      if (matches.length > 1) {
        throw new LassiError(
          'validation',
          `${matches.length} links match ${resolved.sentence} (ids ${matches.map((l) => l.id).join(', ')})`,
          { hint: 'remove the extra links in Jira; lassi deletes one link at a time', context }
        );
      }
      const match = matches[0] as JiraIssueLink;
      const preview = {
        method: 'DELETE' as const,
        path: `/rest/api/2/issueLink/${match.id}`,
        payloadLabel: 'link',
        payload: `${match.id}: ${resolved.sentence}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.deleteLink(match.id);
      return {
        markdown: `deleted link: ${resolved.sentence}\n`,
        data: { id: match.id, type: resolved.type.name, sentence: resolved.sentence },
      };
    },
  });
}
