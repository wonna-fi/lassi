import type { Command } from 'commander';
import {
  formatOf,
  isExcluded,
  isWritable,
  type FieldFormat,
  type FieldPolicy,
  type JiraFieldDef,
  type JiraLinkType,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import type { CliDeps } from '../../deps.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { registerGenerated } from '../skills/generated.js';
import { fieldPolicyOf, jiraClient } from './shared.js';

/** What Lassi does with one aliased field, from `jira.fields`. */
interface FieldAccess {
  editable: boolean;
  format: FieldFormat;
  exclude: boolean;
}

export interface FieldsReport {
  resolved: Array<{ alias: string; id: string; name: string; type: string } & FieldAccess>;
  unresolved: Array<{ alias: string; id: string } & FieldAccess>;
}

export function buildFieldsReport(policy: FieldPolicy, defs: JiraFieldDef[]): FieldsReport {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const report: FieldsReport = { resolved: [], unresolved: [] };
  for (const [alias, id] of Object.entries(policy.aliases)) {
    const access: FieldAccess = {
      editable: isWritable(policy, id),
      format: formatOf(policy, id),
      exclude: isExcluded(policy, id),
    };
    const def = byId.get(id);
    if (def) {
      const type =
        def.schema?.type === 'array'
          ? `array<${def.schema.items ?? '?'}>`
          : (def.schema?.type ?? '?');
      report.resolved.push({ alias, id, name: def.name, type, ...access });
    } else {
      report.unresolved.push({ alias, id, ...access });
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
      { key: 'access', header: 'Access' },
      { key: 'notes', header: 'Notes' },
    ],
    report.resolved.map((r) => ({
      ...r,
      access: r.editable ? 'editable' : 'read-only',
      notes: [r.format === 'wiki' ? 'wiki' : '', r.exclude ? 'excluded' : '']
        .filter(Boolean)
        .join(', '),
    }))
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
    'Custom fields are read-only unless `jira.fields` marks them editable, and unaliased custom fields are',
    'always read-only. Set an editable field with `--field alias=value` (or its raw id) or as a top-level',
    'frontmatter key in a working file; the CLI maps the alias to the field id. Read-only fields appear',
    'under `readonly` in working files, and excluded fields are left out. A `wiki` field shows Jira wiki',
    'markup as Markdown: write Markdown to it, never JSON or wiki markup. Run',
    '`lassi jira issue createmeta <PROJECT> --type <TYPE>` for required flags and allowed values.',
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
    '`lassi jira issue link create A B --type "<phrase>"` accepts the outward phrase or the type name',
    '(A <outward> B) or the inward phrase (A <inward> B, direction flipped). `--dry-run` prints the',
    'resolved sentence. `lassi jira issue link delete A B --type "<phrase>"` removes the link that',
    '`lassi jira issue link list A` shows as A <phrase> B.',
    '',
    table,
  ].join('\n');
}

export function registerReference(jira: Command, deps: CliDeps, session: Session): void {
  const fields = jira
    .command('fields')
    .description('configured field aliases resolved against this instance, with their access')
    .option('--md', 'render the skill reference (fields.md)');
  attach<[], { md?: boolean }>(fields, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const policy = fieldPolicyOf(ctx);
      const defs =
        Object.keys(policy.aliases).length > 0 ? await (await jiraClient(ctx)).fields() : [];
      const report = buildFieldsReport(policy, defs);
      return { markdown: renderFields(report, { md: Boolean(opts.md) }), data: report };
    },
  });

  const link = jira.command('link').description('instance link types');
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

  registerGenerated('jira/references/fields.md', async (ctx: Context) => {
    const policy = fieldPolicyOf(ctx);
    const defs =
      Object.keys(policy.aliases).length > 0 ? await (await jiraClient(ctx)).fields() : [];
    return renderFields(buildFieldsReport(policy, defs), { md: true });
  });
  registerGenerated('jira/references/link-types.md', async (ctx: Context) => {
    const list = await (await jiraClient(ctx)).getLinkTypes();
    return renderLinkTypes(list, { md: true });
  });
}
