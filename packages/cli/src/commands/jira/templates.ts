import type { Command } from 'commander';
import { LassiError, displayPath, resolvePath, type IssueTemplate } from '@wonna/lassi-core';
import type { Context } from '../../context.js';
import type { CliDeps } from '../../deps.js';
import { truncate } from '../../output/axi.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';

const NONE = 'no issue templates configured (jira.templates in .lassi.json)';

/** `jira.templates.<name>`, or a usage error that lists what is configured. */
export function templateNamed(ctx: Context, name: string): IssueTemplate {
  const templates = ctx.config.jira.templates;
  // Own properties only: `toString` is not a template.
  const template = Object.hasOwn(templates, name) ? templates[name] : undefined;
  if (template) return template;
  const names = Object.keys(templates);
  throw new LassiError(
    'usage',
    names.length === 0 ? NONE : `unknown template "${name}"; configured: ${names.join(', ')}`,
    { hint: 'run `lassi jira templates` for the list' }
  );
}

/** The description skeleton: inline text, the file's content, or nothing. */
export async function templateDescription(
  deps: CliDeps,
  name: string,
  template: IssueTemplate
): Promise<string | undefined> {
  if (template.description !== undefined) return template.description;
  if (template.descriptionFile === undefined) return undefined;
  try {
    return await deps.fs.readFile(template.descriptionFile);
  } catch (err) {
    throw new LassiError(
      'usage',
      `template "${name}": cannot read ${template.descriptionFile}: ${(err as Error).message}`
    );
  }
}

const fieldList = (t: IssueTemplate): string =>
  Object.entries(t.fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');

function descriptionLabel(cwd: string, t: IssueTemplate): string {
  if (t.description !== undefined) return `inline (${t.description.split('\n').length} lines)`;
  if (t.descriptionFile !== undefined) return `file ${displayPath(cwd, t.descriptionFile)}`;
  return '-';
}

function createLine(name: string, t: IssueTemplate, defaultProject: string | undefined): string {
  const parts = ['lassi jira issue create', `--template ${name}`];
  if (t.project === undefined && defaultProject === undefined) parts.push('--project <P>');
  if (t.type === undefined) parts.push('--type <T>');
  if (t.summary === undefined) parts.push('--summary "<summary>"');
  parts.push('[--file <md>]');
  return parts.join(' ');
}

export function registerTemplates(jira: Command, deps: CliDeps, session: Session): void {
  const templates = jira
    .command('templates [NAME]')
    .description(
      'issue templates from jira.templates: the table, or one template with its description skeleton to copy, fill in and pass as --file'
    )
    .option('--out <file>', 'with NAME: write only the description skeleton to a file');
  attach<[string | undefined], { out?: string }>(templates, deps, session, {
    kind: 'read',
    async run(ctx, [name], opts) {
      const all = ctx.config.jira.templates;
      if (opts.out !== undefined && name === undefined) {
        throw new LassiError('usage', '--out needs a template name');
      }
      if (name !== undefined) {
        const t = templateNamed(ctx, name);
        const description = await templateDescription(deps, name, t);
        if (opts.out !== undefined) {
          if (description === undefined) {
            throw new LassiError('usage', `template "${name}" has no description skeleton`);
          }
          const path = resolvePath(deps.cwd, opts.out);
          await deps.fs.writeFile(
            path,
            description.endsWith('\n') ? description : `${description}\n`
          );
          const data = { name, path: displayPath(deps.cwd, path) };
          return { markdown: `wrote ${data.path}\n`, data, axi: { data } };
        }
        const lines = [
          `# Template ${name}`,
          '',
          `- type: ${t.type ?? '(pass --type)'}`,
          `- project: ${t.project ?? ctx.config.jira.defaultProject ?? '(pass --project)'}`,
          `- summary: ${t.summary ?? '(pass --summary)'}`,
          `- fields: ${fieldList(t) || '-'}`,
          `- create: \`${createLine(name, t, ctx.config.jira.defaultProject)}\``,
          '',
          '## Description',
          '',
          description === undefined
            ? '(no skeleton; write the description yourself)'
            : description.trimEnd(),
          '',
        ];
        const data = {
          name,
          type: t.type ?? null,
          project: t.project ?? ctx.config.jira.defaultProject ?? null,
          summary: t.summary ?? null,
          fields: t.fields,
          description: description ?? null,
          ...(t.descriptionFile === undefined ? {} : { descriptionFile: t.descriptionFile }),
        };
        return {
          markdown: lines.join('\n'),
          data,
          axi: {
            data: {
              ...data,
              description: description === undefined ? null : truncate(description),
            },
          },
        };
      }
      const rows = Object.entries(all).map(([n, t]) => ({
        name: n,
        type: t.type ?? '',
        project: t.project ?? '',
        summary: t.summary ?? '',
        fields: fieldList(t),
        description: descriptionLabel(deps.cwd, t),
      }));
      const markdown =
        rows.length === 0
          ? `${NONE}\n`
          : renderTable(
              [
                { key: 'name', header: 'Template' },
                { key: 'type', header: 'Type' },
                { key: 'project', header: 'Project' },
                { key: 'summary', header: 'Summary' },
                { key: 'fields', header: 'Fields' },
                { key: 'description', header: 'Description' },
              ],
              rows
            );
      return { markdown, data: { templates: rows }, axi: { data: { templates: rows } } };
    },
  });
}
