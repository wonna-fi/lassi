import type { Command } from 'commander';
import { LassiError, isLassiError, type HintContext } from '@wonna/lassi-core';
import {
  aliasFor,
  coerceFieldValue,
  fieldIdFor,
  parseFieldArg,
  resolveTransition,
  type JiraTransition,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { markdownBodyToWiki } from './body.js';
import { resolveIssueKey } from './issue-key.js';
import { aliasesOf, group, jiraClient } from './shared.js';

interface DoOptions {
  field: string[];
  comment?: string;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function screenFields(t: JiraTransition, aliases: Record<string, string>): string {
  return Object.values(t.fields)
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
    .map((f) => `${aliasFor(aliases, f.fieldId) ?? f.fieldId}${f.required ? '*' : ''}`)
    .join(', ');
}

export function registerTransition(jira: Command, deps: CliDeps, session: Session): void {
  const transition = group(jira, 'transition', 'workflow transitions');

  const list = transition
    .command('list <KEY>')
    .description('available transitions with target status and screen fields (* = required)');
  attach<[string], Record<string, never>>(list, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg]) {
      const key = await resolveIssueKey(ctx, keyArg);
      const transitions = await (await jiraClient(ctx)).listTransitions(key);
      const aliases = aliasesOf(ctx);
      const rows = transitions.map((t) => ({
        id: t.id,
        name: t.name,
        to: t.to.name,
        fields: screenFields(t, aliases),
      }));
      const table = renderTable(
        [
          { key: 'id', header: 'Id' },
          { key: 'name', header: 'Name' },
          { key: 'to', header: 'To' },
          { key: 'fields', header: 'Screen fields' },
        ],
        rows
      );
      return {
        markdown:
          transitions.length === 0
            ? `no transitions available on ${key}\n`
            : `# ${key} transitions\n\n${table}`,
        data: { key, transitions },
        axi: { data: { key, count: rows.length, transitions: rows } },
      };
    },
  });

  const run = transition
    .command('do <KEY> <NAME|ID>')
    .description('perform a transition, with optional screen fields and a markdown comment')
    .option('--field <alias=value>', 'screen field by alias or id (repeatable)', collect, [])
    .option('--comment <md>', 'comment to add with the transition');
  attach<[string, string], DoOptions>(run, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, nameOrId], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const aliases = aliasesOf(ctx);
      const chosen = resolveTransition(await client.listTransitions(key), nameOrId, key);
      const context: HintContext = {
        product: 'jira',
        issueKey: key,
        transition: true,
        operation: 'transition',
      };
      const fields: Record<string, unknown> = {};
      for (const arg of opts.field) {
        const { key: name, raw } = parseFieldArg(arg);
        const id =
          fieldIdFor(aliases, name) ?? (Object.hasOwn(chosen.fields, name) ? name : undefined);
        if (id === undefined) {
          throw new LassiError('usage', `unknown field "${name}" for transition ${chosen.name}`, {
            hint: `run \`lassi jira transition list ${key}\` to see the screen fields`,
            context,
          });
        }
        try {
          fields[id] = coerceFieldValue(raw, chosen.fields[id], id);
        } catch (err) {
          if (isLassiError(err)) err.context = { ...context, ...err.context };
          throw err;
        }
      }
      const missing = Object.values(chosen.fields)
        .filter((f) => f.required && !f.hasDefaultValue && fields[f.fieldId] === undefined)
        .map((f) => f.fieldId);
      if (missing.length > 0) {
        throw new LassiError(
          'validation',
          `transition ${chosen.name} needs: ${missing.map((id) => aliasFor(aliases, id) ?? id).join(', ')}`,
          {
            errors: Object.fromEntries(
              missing.map((id) => [id, `${chosen.fields[id]?.name ?? id} is required.`])
            ),
            context,
          }
        );
      }
      const commentBody =
        opts.comment === undefined
          ? undefined
          : await markdownBodyToWiki(ctx, client, opts.comment);
      const body = {
        transition: { id: chosen.id },
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        ...(commentBody === undefined
          ? {}
          : { update: { comment: [{ add: { body: commentBody } }] } }),
      };
      const preview = {
        method: 'POST' as const,
        path: `/rest/api/2/issue/${key}/transitions`,
        payloadLabel: 'transition (json)',
        payload: JSON.stringify(body, null, 2),
        note: `${key}: ${chosen.name} → ${chosen.to.name}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.doTransition(key, {
        id: chosen.id,
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        ...(commentBody === undefined ? {} : { commentBody }),
      });
      return {
        markdown: `${key}: ${chosen.name} → ${chosen.to.name}\n`,
        data: { key, transition: chosen.id, name: chosen.name, to: chosen.to.name },
      };
    },
  });
}
