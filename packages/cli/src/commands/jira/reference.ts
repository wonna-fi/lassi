import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import { resolveLinkDirection, type JiraFieldDef, type JiraLinkType } from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { registerGenerated } from '../skills/generated.js';
import { resolveIssueKey } from './issue-key.js';
import { aliasesOf, jiraClient } from './shared.js';

export interface FieldsReport {
  resolved: Array<{ alias: string; id: string; name: string; type: string }>;
  unresolved: Array<{ alias: string; id: string }>;
}

export function buildFieldsReport(
  aliases: Record<string, string>,
  defs: JiraFieldDef[]
): FieldsReport {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const report: FieldsReport = { resolved: [], unresolved: [] };
  for (const [alias, id] of Object.entries(aliases)) {
    const def = byId.get(id);
    if (def) {
      const type =
        def.schema?.type === 'array'
          ? `array<${def.schema.items ?? '?'}>`
          : (def.schema?.type ?? '?');
      report.resolved.push({ alias, id, name: def.name, type });
    } else {
      report.unresolved.push({ alias, id });
    }
  }
  return report;
}

export function renderFields(report: FieldsReport, opts: { md: boolean }): string {
  const table = renderTable(
    [
      { key: 'alias', header: 'Alias' },
      { key: 'id', header: 'Field id' },
      { key: 'name', header: 'Name' },
      { key: 'type', header: 'Type' },
    ],
    report.resolved
  );
  const unresolved =
    report.unresolved.length > 0
      ? `\nUnresolved aliases (not a field on this instance): ${report.unresolved.map((u) => `${u.alias} → ${u.id}`).join(', ')}\n`
      : '';
  if (!opts.md) {
    if (report.resolved.length === 0 && report.unresolved.length === 0)
      return 'no field aliases configured (jira.fields in .lassi.json)\n';
    return `${table}${unresolved}`;
  }
  return [
    '# Jira field aliases',
    '',
    'Use the alias with `--field alias=value` and as a frontmatter key in working files; the CLI maps it',
    'to the field id. Run `lassi jira issue createmeta <PROJECT> --type <TYPE>` for required flags and',
    'allowed values.',
    '',
    report.resolved.length > 0 ? table : '(no aliases configured)\n',
    unresolved,
  ].join('\n');
}

export function renderLinkTypes(types: JiraLinkType[], opts: { md: boolean }): string {
  const table = renderTable(
    [
      { key: 'name', header: 'Name' },
      { key: 'outward', header: 'Outward (A → B)' },
      { key: 'inward', header: 'Inward (B → A)' },
    ],
    types
  );
  if (!opts.md) return table;
  return [
    '# Jira link types',
    '',
    '`lassi jira link create A B --type "<phrase>"` accepts the outward phrase or the type name',
    '(A <outward> B) or the inward phrase (A <inward> B, direction flipped). `--dry-run` prints the',
    'resolved sentence.',
    '',
    table,
  ].join('\n');
}

export function registerReference(jira: Command, deps: CliDeps, session: Session): void {
  const fields = jira
    .command('fields')
    .description('configured field aliases resolved against this instance')
    .option('--md', 'render the skill reference (fields.md)');
  attach<[], { md?: boolean }>(fields, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const aliases = aliasesOf(ctx);
      const defs = Object.keys(aliases).length > 0 ? await (await jiraClient(ctx)).fields() : [];
      const report = buildFieldsReport(aliases, defs);
      return { markdown: renderFields(report, { md: Boolean(opts.md) }), data: report };
    },
  });

  const link = jira.command('link').description('issue links');
  const types = link
    .command('types')
    .description('link types with outward and inward names')
    .option('--md', 'render the skill reference (link-types.md)');
  attach<[], { md?: boolean }>(types, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const list = await (await jiraClient(ctx)).getLinkTypes();
      return { markdown: renderLinkTypes(list, { md: Boolean(opts.md) }), data: list };
    },
  });
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
      const body = {
        type: { name: resolved.type.name },
        outwardIssue: { key: resolved.outwardKey },
        inwardIssue: { key: resolved.inwardKey },
      };
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
        outwardKey: resolved.outwardKey,
        inwardKey: resolved.inwardKey,
      });
      return { markdown: `${resolved.sentence}\n`, data: { ...body, sentence: resolved.sentence } };
    },
  });

  registerGenerated('jira/references/fields.md', async (ctx: Context) => {
    const aliases = aliasesOf(ctx);
    const defs = Object.keys(aliases).length > 0 ? await (await jiraClient(ctx)).fields() : [];
    return renderFields(buildFieldsReport(aliases, defs), { md: true });
  });
  registerGenerated('jira/references/link-types.md', async (ctx: Context) => {
    const list = await (await jiraClient(ctx)).getLinkTypes();
    return renderLinkTypes(list, { md: true });
  });
}
