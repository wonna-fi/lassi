import type { Command } from 'commander';
import { LassiError, isLassiError } from '@wonna/lassi-core';
import {
  assertProjectKey,
  componentCreateRequest,
  componentRef,
  componentUpdate,
  findByName,
  planComponentAdd,
  planComponentRemove,
  type JiraComponent,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData, type DryRunPreview } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { resolveIssueKey } from './issue-key.js';
import { group, jiraClient, withProjectHints } from './shared.js';

const joined = (names: string[]): string => names.join(', ');

/** `jira project component …`: the components of a project. */
export function registerComponent(project: Command, deps: CliDeps, session: Session): void {
  const component = group(project, 'component', 'project components');

  const list = component.command('list <PROJECT>').description('components of a project');
  attach<[string], Record<string, never>>(list, deps, session, {
    kind: 'read',
    async run(ctx, [projectArg]) {
      const project = assertProjectKey(projectArg);
      const client = await jiraClient(ctx);
      const components = await withProjectHints(project, () => client.listComponents(project));
      const rows = components.map((c) => ({
        name: c.name,
        id: c.id,
        lead: c.lead?.name,
        description: c.description,
        archived: c.archived ? 'yes' : undefined,
      }));
      const table = renderTable(
        [
          { key: 'name', header: 'Name' },
          { key: 'id', header: 'Id' },
          { key: 'lead', header: 'Lead' },
          { key: 'description', header: 'Description' },
          { key: 'archived', header: 'Archived' },
        ],
        rows
      );
      return {
        markdown:
          components.length === 0
            ? `no components in ${project}\n`
            : `# ${project} components\n\n${table}`,
        data: { project, components },
        axi: { data: { project, count: rows.length, components: rows } },
      };
    },
  });

  const create = component
    .command('create <PROJECT> <NAME>')
    .description('create a component in a project (needs project admin rights)')
    .option('--description <text>', 'component description');
  attach<[string, string], { description?: string }>(create, deps, session, {
    kind: 'write',
    async run(ctx, [projectArg, nameArg], opts) {
      const project = assertProjectKey(projectArg);
      const name = nameArg.trim();
      if (name === '') throw new LassiError('usage', 'the component name is empty');
      const client = await jiraClient(ctx);
      const existing = findByName(
        await withProjectHints(project, () => client.listComponents(project)),
        name
      );
      if (existing) {
        throw new LassiError(
          'validation',
          `component "${existing.name}" already exists in ${project} (id ${existing.id})`,
          {
            hint: `add it to an issue with \`lassi jira issue component add <KEY> "${existing.name}"\``,
            context: { product: 'jira' },
          }
        );
      }
      const req = {
        project,
        name,
        ...(opts.description === undefined ? {} : { description: opts.description }),
      };
      const preview: DryRunPreview = {
        method: 'POST',
        path: '/rest/api/2/component',
        payloadLabel: 'component (json)',
        payload: JSON.stringify(componentCreateRequest(req), null, 2),
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const created = await withProjectHints(project, () => client.createComponent(req), {
        creatingComponent: true,
      });
      return {
        markdown: `created component ${created.name} in ${project} (id ${created.id})\n`,
        data: created,
      };
    },
  });
}

/** `jira issue component …`: the components on an issue, which change the issue, not the project. */
export function registerIssueComponent(issue: Command, deps: CliDeps, session: Session): void {
  const component = group(issue, 'component', "an issue's components");

  const add = component
    .command('add <KEY> <NAME...>')
    .description(
      'add components to an issue, keeping its others; --create first creates the ones the project lacks'
    )
    .option('--create', 'create components the project does not have (needs project admin rights)');
  attach<[string, string[]], { create?: boolean }>(add, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, names], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const issue = await client.getIssue(key, { fields: ['project', 'components'], expand: [] });
      const project = issue.fields.project?.key;
      if (project === undefined) {
        throw new LassiError('internal', `Jira returned ${key} without its project`);
      }
      const plan = planComponentAdd(names, {
        project,
        projectComponents: await withProjectHints(project, () => client.listComponents(project)),
        issueComponents: issue.fields.components ?? [],
        create: Boolean(opts.create),
      });
      if (plan.add.length === 0 && plan.create.length === 0) {
        return {
          markdown: `no changes for ${key} (it already has ${joined(plan.unchanged)})\n`,
          data: { key, added: [], created: [], unchanged: plan.unchanged },
        };
      }
      // Every create is guarded where it would be sent. A dry run collects their previews and goes
      // on to the issue update, which then names the new components, since they have no id yet.
      const creates: DryRunPreview[] = [];
      const created: JiraComponent[] = [];
      const fresh: Array<{ id?: string; name: string }> = [];
      try {
        for (const name of plan.create) {
          const preview: DryRunPreview = {
            method: 'POST',
            path: '/rest/api/2/component',
            payloadLabel: 'component (json)',
            payload: JSON.stringify(componentCreateRequest({ project, name }), null, 2),
          };
          if (guardWrite(ctx, preview) === 'dry-run') {
            creates.push(preview);
            fresh.push({ name });
            continue;
          }
          const made = await withProjectHints(
            project,
            () => client.createComponent({ project, name }),
            { creatingComponent: true }
          );
          created.push(made);
          fresh.push(made);
        }
        const adding = [...plan.add, ...fresh];
        const body = componentUpdate('add', adding.map(componentRef));
        const preview: DryRunPreview = {
          method: 'PUT',
          path: `/rest/api/2/issue/${key}`,
          payloadLabel: 'update (json)',
          payload: JSON.stringify(body, null, 2),
          note:
            creates.length > 0
              ? `adds ${joined(adding.map((c) => c.name))} to ${key}; the components created first are sent by id`
              : `adds ${joined(adding.map((c) => c.name))} to ${key}`,
        };
        if (guardWrite(ctx, preview) === 'dry-run') {
          return { data: { ...dryRunData(preview), creates } };
        }
        await client.updateIssue(key, body);
        const addedNames = adding.map((c) => c.name);
        const createdNames = created.map((c) => c.name);
        return {
          markdown: `added ${joined(addedNames)} to ${key}${createdNames.length > 0 ? ` (created ${joined(createdNames)} in ${project})` : ''}\n`,
          data: {
            key,
            added: addedNames,
            created: created.map((c) => ({ id: c.id, name: c.name })),
            unchanged: plan.unchanged,
          },
        };
      } catch (err) {
        // A create cannot be taken back, so what now exists is a partial result: printed as data,
        // then the failure. A re-run without --create finds those components and only adds them.
        if (!isLassiError(err) || created.length === 0) throw err;
        return {
          markdown: `created ${joined(created.map((c) => c.name))} in ${project}; added nothing to ${key}\n`,
          data: {
            key,
            added: [],
            created: created.map((c) => ({ id: c.id, name: c.name })),
            unchanged: plan.unchanged,
          },
          error: err,
        };
      }
    },
  });

  const remove = component
    .command('remove <KEY> <NAME...>')
    .description('remove components from an issue; they stay in the project');
  attach<[string, string[]], Record<string, never>>(remove, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, names]) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const issue = await client.getIssue(key, { fields: ['components'], expand: [] });
      const removing = planComponentRemove(names, {
        issueKey: key,
        issueComponents: issue.fields.components ?? [],
      });
      const body = componentUpdate('remove', removing.map(componentRef));
      const removed = removing.map((c) => c.name);
      const preview: DryRunPreview = {
        method: 'PUT',
        path: `/rest/api/2/issue/${key}`,
        payloadLabel: 'update (json)',
        payload: JSON.stringify(body, null, 2),
        note: `removes ${joined(removed)} from ${key}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.updateIssue(key, body);
      return {
        markdown: `removed ${joined(removed)} from ${key}\n`,
        data: { key, removed },
      };
    },
  });
}
